/**
 * Output normalisation: bounded text, structured errors, and the projection of
 * ACP `session/update` notifications into a compact assistant/tool summary.
 */
import { AcpClosedError, AcpError, AcpTimeoutError } from './acp-client.ts';

export interface NormalizedError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/** Recognise the invalid-params wording the DSH ACP server actually emits. */
export function normalizeAcpError(error: unknown): NormalizedError {
  if (error instanceof AcpTimeoutError) {
    return {
      code: 'DSH_ACP_TIMEOUT',
      message: error.message,
      details: { method: error.method, timeout_ms: error.timeoutMs },
    };
  }
  if (error instanceof AcpClosedError) {
    return { code: 'DSH_ACP_UNAVAILABLE', message: error.message, details: { detail: error.detail } };
  }
  if (error instanceof AcpError) {
    const message = error.message;
    const mapped = mapServerMessage(message);
    return {
      code: mapped?.code ?? 'DSH_ACP_ERROR',
      message: mapped?.message ?? message,
      details: { acp_code: error.code, ...(error.data === undefined ? {} : { acp_data: error.data }) },
    };
  }
  if (error instanceof Error) {
    return { code: 'DSH_BRIDGE_ERROR', message: error.message };
  }
  return { code: 'DSH_BRIDGE_ERROR', message: String(error) };
}

function mapServerMessage(message: string): { code: string; message: string } | undefined {
  const rules: Array<{ pattern: RegExp; code: string }> = [
    { pattern: /^unknown session:/i, code: 'DSH_SESSION_UNKNOWN' },
    { pattern: /^session is not resumable:/i, code: 'DSH_SESSION_NOT_RESUMABLE' },
    { pattern: /^session is already active:/i, code: 'DSH_SESSION_ACTIVE' },
    { pattern: /^session cwd does not match:/i, code: 'DSH_CWD_MISMATCH' },
    { pattern: /must be an absolute path/i, code: 'DSH_INVALID_CWD' },
    { pattern: /^the ACP bridge has been disposed/i, code: 'DSH_ACP_UNAVAILABLE' },
    { pattern: /^connection closed/i, code: 'DSH_ACP_UNAVAILABLE' },
  ];
  for (const rule of rules) {
    if (rule.pattern.test(message)) return { code: rule.code, message };
  }
  return undefined;
}

export interface TruncatedText {
  text: string;
  truncated: boolean;
  originalChars: number;
}

export function truncateText(text: string, maxChars: number): TruncatedText {
  const originalChars = text.length;
  if (originalChars <= maxChars) return { text, truncated: false, originalChars };
  const head = Math.max(0, maxChars - 64);
  return {
    text: `${text.slice(0, head)}\n鈥?[truncated ${originalChars - head} chars of ${originalChars}; increase DSH_CODEX_MAX_OUTPUT_CHARS to see more]`,
    truncated: true,
    originalChars,
  };
}

export interface ToolCallSummary {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface UsageSummary {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number | null;
  cachedReadTokens?: number | null;
  cachedWriteTokens?: number | null;
}

export interface CollectedTurn {
  assistantText: string;
  /** Full assistant text length before collector-side clipping. */
  assistantOriginalChars: number;
  assistantTruncated: boolean;
  thoughts: string;
  thoughtsOriginalChars: number;
  thoughtsTruncated: boolean;
  toolCalls: ToolCallSummary[];
  usage: UsageSummary | null;
  configOptions: unknown[] | null;
  /** Notifications that arrived but could not be projected (protocol drift). */
  unknownUpdateKinds: string[];
  /** Tool rawInput/rawOutput fields replaced by a preview because they were too large. */
  truncatedToolFields: number;
}

function textFromContent(content: unknown): string {
  if (content === null || typeof content !== 'object') return '';
  const block = content as Record<string, unknown>;
  if (block.type === 'text' && typeof block.text === 'string') return block.text;
  return '';
}

function serializedLength(value: unknown): number {
  if (typeof value === 'string') return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function clipToolField(
  value: unknown,
  maxChars: number,
): { value: unknown; truncated: boolean } {
  if (value === undefined) return { value, truncated: false };
  const length = serializedLength(value);
  if (length <= maxChars) return { value, truncated: false };
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = '';
  }
  return {
    value: { __truncated: true, originalChars: length, preview: text.slice(0, maxChars) },
    truncated: true,
  };
}

function asToolCallMapEntry(update: Record<string, unknown>): ToolCallSummary | undefined {
  const toolCallId = update.toolCallId;
  if (typeof toolCallId !== 'string' || toolCallId === '') return undefined;
  const entry: ToolCallSummary = { toolCallId };
  if (typeof update.title === 'string') entry.title = update.title;
  if (typeof update.kind === 'string') entry.kind = update.kind;
  if (typeof update.status === 'string') entry.status = update.status;
  if (update.rawInput !== undefined) entry.rawInput = update.rawInput;
  if (update.rawOutput !== undefined) entry.rawOutput = update.rawOutput;
  return entry;
}

/**
 * Accumulate one prompt's updates. Ordering is preserved per stream; tool calls
 * are merged by id so `tool_call` + later `tool_call_update` collapse to one row.
 *
 * Bounds are enforced **while collecting**, not only at the end: assistant and
 * thought text stop growing at `maxChars`, and oversized tool rawInput/rawOutput
 * fields are replaced with a preview. This keeps memory and the MCP response
 * bounded even for long or tool-heavy turns.
 *
 * `agent_thought_chunk` content is **not retained by default**: DSH thoughts are
 * internal reasoning and must not leak into another model's context (Codex).
 * Set `includeThoughts` explicitly to opt in.
 */
export class TurnCollector {
  readonly #assistantChunks: string[] = [];
  readonly #thoughtChunks: string[] = [];
  readonly #toolCalls = new Map<string, ToolCallSummary>();
  readonly #unknown = new Set<string>();
  readonly #includeThoughts: boolean;
  readonly #maxChars: number;
  readonly #maxToolChars: number;
  #assistantChars = 0;
  #thoughtChars = 0;
  #truncatedToolFields = 0;
  #usage: UsageSummary | null = null;
  #configOptions: unknown[] | null = null;

  constructor(options: { includeThoughts?: boolean; maxChars?: number; maxToolChars?: number } = {}) {
    this.#includeThoughts = options.includeThoughts === true;
    this.#maxChars = Math.max(0, options.maxChars ?? 20_000);
    this.#maxToolChars = Math.max(0, options.maxToolChars ?? this.#maxChars);
  }

  #appendText(kind: 'assistant' | 'thought', chunk: string): void {
    if (chunk === '') return;
    const used = kind === 'assistant' ? this.#assistantChars : this.#thoughtChars;
    const remaining = this.#maxChars - used;
    if (remaining > 0) {
      const part = chunk.length <= remaining ? chunk : chunk.slice(0, remaining);
      if (kind === 'assistant') this.#assistantChunks.push(part);
      else this.#thoughtChunks.push(part);
    }
    if (kind === 'assistant') this.#assistantChars += chunk.length;
    else this.#thoughtChars += chunk.length;
  }

  apply(notification: unknown): void {
    if (notification === null || typeof notification !== 'object') return;
    const frame = notification as Record<string, unknown>;
    const update = frame.update;
    if (update === null || typeof update !== 'object') return;
    const record = update as Record<string, unknown>;
    const kind = record.sessionUpdate;
    if (typeof kind !== 'string') {
      this.#unknown.add('<missing sessionUpdate>');
      return;
    }
    switch (kind) {
      case 'agent_message_chunk':
        this.#appendText('assistant', textFromContent(record.content));
        return;
      case 'agent_thought_chunk':
        // Dropped unless the operator explicitly opted in.
        if (this.#includeThoughts) this.#appendText('thought', textFromContent(record.content));
        return;
      case 'tool_call':
      case 'tool_call_update': {
        const entry = asToolCallMapEntry(record);
        if (entry === undefined) return;
        for (const field of ['rawInput', 'rawOutput'] as const) {
          const clipped = clipToolField(entry[field], this.#maxToolChars);
          if (clipped.truncated) this.#truncatedToolFields += 1;
          if (clipped.value === undefined) delete entry[field];
          else entry[field] = clipped.value;
        }
        const previous = this.#toolCalls.get(entry.toolCallId);
        this.#toolCalls.set(entry.toolCallId, { ...previous, ...entry });
        return;
      }
      case 'usage_update': {
        const usage = record.usage;
        if (usage !== null && typeof usage === 'object') {
          this.#usage = usage as UsageSummary;
        }
        return;
      }
      case 'config_option_update':
      case 'config_options_update': {
        const options = record.configOptions;
        if (Array.isArray(options)) this.#configOptions = options;
        return;
      }
      case 'user_message_chunk':
        // DSH does not emit this; tolerate other future agents silently.
        return;
      default:
        this.#unknown.add(kind);
        return;
    }
  }

  collect(): CollectedTurn {
    const assistantText = this.#assistantChunks.join('');
    const thoughts = this.#thoughtChunks.join('');
    return {
      assistantText,
      assistantOriginalChars: this.#assistantChars,
      assistantTruncated: this.#assistantChars > assistantText.length,
      thoughts,
      thoughtsOriginalChars: this.#thoughtChars,
      thoughtsTruncated: this.#thoughtChars > thoughts.length,
      toolCalls: [...this.#toolCalls.values()],
      usage: this.#usage,
      configOptions: this.#configOptions,
      unknownUpdateKinds: [...this.#unknown],
      truncatedToolFields: this.#truncatedToolFields,
    };
  }

  get seenAnyMessage(): boolean {
    return this.#assistantChunks.length > 0 || this.#toolCalls.size > 0;
  }
}
