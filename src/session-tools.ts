/**
 * Business tools mapped onto the DSH ACP surface.
 *
 * v0.2.0 scope: create a fresh session and drive it (prompt / cancel / close),
 * plus a bounded local delete for sessions this bridge process created. The ACP
 * surface has no session/delete, so delete is the one deliberate exception that
 * touches DSH storage directly; it is restricted to this process's own sessions
 * and documented in README/SECURITY.
 *
 * There is deliberately NO session listing and NO resume: DSH ACP cannot replay
 * prior transcripts and resuming a persisted session is unreliable across
 * frontends, so the bridge does not pretend to offer history access.
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  AcpClient,
  AcpTimeoutError,
  type InitializeResult,
  type PermissionDecision,
  type PermissionRequest,
} from './acp-client.ts';
import { AcpProcess, type Logger } from './acp-process.ts';
import {
  type BridgeConfig,
  defaultDshHome,
  validateCwd,
  validateSelection,
} from './config.ts';
import { TurnCollector, normalizeAcpError, type NormalizedError } from './output.ts';

export class BridgeError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.details = details;
  }
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

export interface ToolCallOutcome {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface ToolCatalog {
  tools: ToolDefinition[];
  /** Why some tools are missing, when applicable. */
  notes: string[];
}

interface SessionRecord {
  sessionId: string;
  cwd: string;
  createdAt: number;
}

interface InflightPrompt {
  policy: 'deny' | 'allow_once';
  collector: TurnCollector;
  abort: AbortController;
}

function tool(name: string, title: string, description: string, inputSchema: Record<string, unknown>, annotations: ToolDefinition['annotations']): ToolDefinition {
  return { name, title, description, inputSchema, annotations };
}

function schemaObject(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

const NO_HISTORY_NOTE =
  'The bridge does not list or resume sessions, and it never reads or replays prior transcripts: every conversation starts at dsh_create_session.';

export class SessionBridge {
  readonly #config: BridgeConfig;
  readonly #logger: Logger;
  /** Sessions activated by this ACP connection (prompt/close targets). */
  readonly #sessions = new Map<string, SessionRecord>();
  /**
   * Sessions created by this bridge process. Only these may be deleted: after a
   * reconnect the ACP child forgets them, but the process still knows it made
   * them. A fresh bridge process starts empty (use scripts/prune-sessions.ts).
   */
  readonly #created = new Set<string>();
  readonly #inflight = new Map<string, InflightPrompt>();
  readonly #permissionLog: Array<{ sessionId: string; toolCallId: string; decision: string }> = [];

  #process: AcpProcess | undefined;
  #client: AcpClient | undefined;
  #connecting: Promise<AcpClient> | undefined;
  #lastConnectError: NormalizedError | undefined;
  #lastFailure: { at: number; error: NormalizedError } | undefined;
  #shuttingDown = false;
  #startedAt = 0;
  #initializeResult: InitializeResult | undefined;
  /** Avoid hot-looping child spawns when DSH is missing or broken. */
  readonly #connectRetryCooldownMs = 3_000;

  constructor(config: BridgeConfig, logger: Logger) {
    this.#config = config;
    this.#logger = logger;
  }

  get connected(): boolean {
    return this.#client !== undefined && !this.#client.closed;
  }

  get lastConnectError(): NormalizedError | undefined {
    return this.#lastConnectError;
  }

  get capabilities(): InitializeResult['agentCapabilities'] | undefined {
    return this.#client?.capabilities;
  }

  get agentInfo(): InitializeResult['agentInfo'] {
    return this.#client?.agentInfo;
  }

  get startedAt(): number {
    return this.#startedAt;
  }

  /** Establish (or re-establish) the ACP child process and handshake. */
  async ensureConnected(): Promise<AcpClient> {
    // A handshake in progress owns an uninitialised client: join it first,
    // otherwise a concurrent caller would observe empty capabilities.
    if (this.#connecting !== undefined) return this.#connecting;
    if (this.#client !== undefined && !this.#client.closed) return this.#client;
    if (this.#shuttingDown) throw new BridgeError('DSH_BRIDGE_SHUTDOWN', 'the bridge is shutting down');
    if (this.#lastFailure !== undefined && Date.now() - this.#lastFailure.at < this.#connectRetryCooldownMs) {
      throw new BridgeError(
        this.#lastFailure.error.code,
        this.#lastFailure.error.message,
        this.#lastFailure.error.details,
      );
    }

    this.#connecting = this.#connect()
      .then((client) => {
        this.#lastFailure = undefined;
        return client;
      })
      .catch((error: unknown) => {
        const normalized =
          error instanceof BridgeError
            ? { code: error.code, message: error.message, details: error.details }
            : normalizeAcpError(error);
        this.#lastFailure = { at: Date.now(), error: normalized };
        throw error instanceof BridgeError
          ? error
          : new BridgeError(normalized.code, normalized.message, normalized.details);
      })
      .finally(() => {
        this.#connecting = undefined;
      });
    return this.#connecting;
  }

  async #connect(): Promise<AcpClient> {
    // Tear down any half-dead previous attempt first.
    if (this.#process !== undefined) {
      await this.#process.close(this.#config.closeTimeoutMs).catch(() => undefined);
    }
    this.#client?.close();
    this.#client = undefined;
    this.#process = undefined;
    this.#lastConnectError = undefined;
    // A new ACP process knows nothing about the sessions the previous one had
    // activated; drop our records so prompt/close do not trust stale state.
    this.#forgetActiveSessions('acp reconnect');

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.#config.dshHome !== undefined) env.DSH_HOME = this.#config.dshHome;

    const child = new AcpProcess({
      command: this.#config.dshCommand,
      args: [...this.#config.dshArgs, '--profile', this.#config.profile],
      env,
      logger: this.#logger,
      onExit: (exit) => {
        this.#forgetActiveSessions('dsh acp process exited');
        this.#client?.markClosed(
          `dsh acp process exited (code=${String(exit.code)}, signal=${String(exit.signal)})`,
        );
      },
    });

    try {
      child.start();
    } catch (error) {
      const normalized = normalizeAcpError(error);
      this.#lastConnectError = normalized;
      throw new BridgeError(normalized.code, normalized.message, normalized.details);
    }

    const client = new AcpClient({
      input: child.child.stdout,
      output: child.child.stdin,
      requestTimeoutMs: this.#config.callTimeoutMs,
      clientName: 'codex-dsh-mcp',
      clientVersion: '0.2.0',
      onNotification: (method, params) => {
        if (method === 'session/update') {
          this.#routeUpdate(params);
          return;
        }
        this.#logger.debug(`ignoring ACP notification ${method}`);
      },
      onRequest: (method, params) => this.#handleAgentRequest(method, params),
      onProtocolWarning: (message) => this.#logger.error(`acp protocol warning: ${message}`),
    });

    this.#process = child;
    this.#client = client;

    try {
      const initialized = await client.initialize({ timeoutMs: this.#config.connectTimeoutMs });
      this.#initializeResult = initialized;
      this.#startedAt = Date.now();
      this.#logger.info(
        `connected to dsh acp (agent=${initialized.agentInfo?.name ?? 'unknown'} v${initialized.agentInfo?.version ?? '?'})`,
      );
      return client;
    } catch (error) {
      const normalized = normalizeAcpError(error);
      this.#lastConnectError = normalized;
      this.#forgetActiveSessions('acp handshake failed');
      client.markClosed(normalized.message);
      await child.close(this.#config.closeTimeoutMs).catch(() => undefined);
      this.#process = undefined;
      this.#client = undefined;
      throw new BridgeError(normalized.code, normalized.message, normalized.details);
    }
  }

  /** Drop records that are only valid for the ACP connection that created them. */
  #forgetActiveSessions(reason: string): void {
    if (this.#sessions.size > 0 || this.#inflight.size > 0) {
      this.#logger.info(`forgetting ${this.#sessions.size} active session record(s): ${reason}`);
    }
    this.#sessions.clear();
    this.#inflight.clear();
  }

  /**
   * Forward an MCP request cancellation to the matching ACP session.
   *
   * Returns true when an in-flight prompt was found (and aborted locally); DSH
   * still decides cooperatively whether it stops.
   */
  cancelInFlight(sessionId: string): boolean {
    const inflight = this.#inflight.get(sessionId);
    if (inflight === undefined) return false;
    try {
      this.#client?.notify('session/cancel', { sessionId });
    } catch {
      // The connection may already be gone; the abort below still releases us.
    }
    inflight.abort.abort();
    return true;
  }

  #routeUpdate(params: unknown): void {
    if (params === null || typeof params !== 'object') return;
    const sessionId = (params as Record<string, unknown>).sessionId;
    if (typeof sessionId !== 'string') return;
    this.#inflight.get(sessionId)?.collector.apply(params);
  }

  /** Answer `session/request_permission` from the current prompt's policy. */
  async #handleAgentRequest(method: string, params: unknown): Promise<unknown> {
    if (method !== 'session/request_permission') {
      throw new BridgeError('DSH_UNSUPPORTED', `the bridge does not implement agent request ${method}`);
    }
    const request = params as PermissionRequest;
    const inflight = this.#inflight.get(request.sessionId);
    const policy = inflight?.policy ?? 'deny';
    const decision = decidePermission(request, policy);
    this.#permissionLog.push({
      sessionId: request.sessionId,
      toolCallId: request.toolCall?.toolCallId ?? 'unknown',
      decision: decision.outcome,
    });
    if (this.#permissionLog.length > 200) this.#permissionLog.splice(0, this.#permissionLog.length - 200);
    this.#logger.info(
      `permission request for session ${request.sessionId} toolCall=${request.toolCall?.toolCallId ?? '?'} -> ${decision.outcome}`,
    );
    return { outcome: decision };
  }

  /** Build the tool catalog from the negotiated capabilities. */
  catalog(): ToolCatalog {
    const notes: string[] = [NO_HISTORY_NOTE];
    const tools: ToolDefinition[] = [
      tool(
        'dsh_create_session',
        'Create a DSH session',
        'Create a fresh persistent DSH session via ACP session/new. cwd must be absolute, inside the configured allowlist, and is realpath-canonicalised before use. model / reasoning_effort are only accepted when explicitly allowlisted by the bridge. Every conversation starts here: the bridge does not list or resume existing sessions.',
        schemaObject(
          {
            cwd: { type: 'string', description: 'Absolute working directory for the new session.' },
            model: { type: 'string', description: 'Optional model id; must be allowlisted (DSH_CODEX_ALLOWED_MODELS).' },
            reasoning_effort: {
              type: 'string',
              description: 'Optional reasoning effort; must be allowlisted (DSH_CODEX_ALLOWED_REASONING_EFFORTS).',
            },
            profile: { type: 'string', description: 'Optional DSH profile; must equal the bridge profile.' },
          },
          ['cwd'],
        ),
        { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      ),
      tool(
        'dsh_send_message',
        'Send a message to a DSH session',
        'Send one user text message to a session created by this bridge process via ACP session/prompt and wait for the turn to settle. Exactly one prompt may be in flight per session. Returns the assistant text, a tool-call summary and usage. DSH internal thoughts (agent_thought_chunk) are NOT returned unless the operator set DSH_CODEX_INCLUDE_THOUGHTS. Permission requests made by DSH tools are DENIED unless permission_policy is explicitly "allow_once"; they are never auto-approved.',
        schemaObject(
          {
            session_id: { type: 'string', description: 'Explicit session id returned by dsh_create_session.' },
            text: { type: 'string', description: 'User message text.' },
            permission_policy: {
              type: 'string',
              enum: ['deny', 'allow_once'],
              default: 'deny',
              description: 'How to answer DSH tool permission requests for this turn.',
            },
            timeout_ms: {
              type: 'integer',
              minimum: 1000,
              description: 'Prompt settlement timeout; capped by the bridge prompt timeout.',
            },
          },
          ['session_id', 'text'],
        ),
        { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      ),
      tool(
        'dsh_cancel_session',
        'Cancel a DSH session run',
        'Ask the ACP session/cancel method to stop the work of exactly one session. The in-flight prompt settles with stopReason "cancelled"; other sessions are untouched.',
        schemaObject({ session_id: { type: 'string', description: 'Explicit session id to cancel.' } }, ['session_id']),
        { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      ),
    ];

    const client = this.#client;
    const knownCapabilities = client !== undefined && !client.closed;

    if (client !== undefined && !client.closed && !client.supportsSessionClose) {
      notes.push('dsh_close_session and dsh_delete_session (when the session is still active) are hidden: the agent did not advertise sessionCapabilities.close.');
    } else {
      tools.push(tool(
        'dsh_close_session',
        'Close a DSH session',
        'Close exactly one session via ACP session/close. This cancels in-flight work, drains updates, flushes persistence, and releases the session run scope. Persisted storage is retained (the bridge offers no resume, so the session becomes dormant). Requires confirm=true. Closing is NOT read-only and is NOT a safe way to inspect a session; it will cancel that session\'s in-flight work.',
        schemaObject(
          {
            session_id: { type: 'string', description: 'Explicit session id to close.' },
            confirm: {
              type: 'boolean',
              description:
                'Must be true: closing cancels in-flight work and releases run resources (it is not read-only).',
            },
          },
          ['session_id', 'confirm'],
        ),
        { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      ));
    }

    tools.push(tool(
      'dsh_delete_session',
      'Delete a DSH session (local storage)',
      'Permanently delete the local persisted storage of a session CREATED BY THIS BRIDGE PROCESS. DSH ACP has no session/delete method, so this removes the session directory under DSH_HOME/sessions directly; it is the only way to remove one. A still-active session is closed first (requires sessionCapabilities.close). Requires confirm=true. Sessions created by the desktop app or by a previous bridge process are refused; run scripts/prune-sessions.ts for explicit manual cleanup.',
      schemaObject(
        {
          session_id: { type: 'string', description: 'Explicit session id created by this bridge process.' },
          confirm: {
            type: 'boolean',
            description: 'Must be true: deleting permanently removes the session\'s local persisted files (cannot be undone).',
          },
        },
        ['session_id', 'confirm'],
      ),
      { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    ));

    if (!knownCapabilities) {
      notes.push(
        'ACP capabilities are not negotiated yet: the catalog lists the default tools and any call that hits a missing method returns DSH_UNSUPPORTED.',
      );
    }
    if (this.#lastConnectError !== undefined) {
      notes.push(
        `ACP handshake unavailable: ${this.#lastConnectError.code} ${this.#lastConnectError.message}`,
      );
    }
    return { tools, notes };
  }

  async call(name: string, args: Record<string, unknown> | undefined): Promise<ToolCallOutcome> {
    const input = args ?? {};
    try {
      switch (name) {
        case 'dsh_create_session':
          return await this.#createSession(input);
        case 'dsh_send_message':
          return await this.#sendMessage(input);
        case 'dsh_cancel_session':
          return await this.#cancelSession(input);
        case 'dsh_close_session':
          return await this.#closeSession(input);
        case 'dsh_delete_session':
          return await this.#deleteSession(input);
        default:
          throw new BridgeError('DSH_UNKNOWN_TOOL', `unknown tool ${name}`);
      }
    } catch (error) {
      const normalized = error instanceof BridgeError
        ? { code: error.code, message: error.message, details: error.details }
        : normalizeAcpError(error);
      this.#logger.info(`tool ${name} failed: ${normalized.code} ${normalized.message}`);
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: normalized }, null, 2) }],
        isError: true,
      };
    }
  }

  async #requireClient(): Promise<AcpClient> {
    return this.ensureConnected();
  }

  async #createSession(input: Record<string, unknown>): Promise<ToolCallOutcome> {
    const client = await this.#requireClient();
    const cwdDecision = validateCwd(input.cwd, this.#config);
    if (!cwdDecision.ok || cwdDecision.cwd === undefined) {
      throw new BridgeError('DSH_INVALID_CWD', cwdDecision.reason ?? 'invalid cwd');
    }
    if (input.profile !== undefined) {
      const requested = readOptionalString(input.profile, 'profile');
      if (requested !== undefined && requested !== this.#config.profile) {
        throw new BridgeError(
          'DSH_UNSUPPORTED',
          `profile ${JSON.stringify(requested)} is not the active bridge profile ${JSON.stringify(this.#config.profile)}; restart the bridge with DSH_CODEX_PROFILE to switch`,
        );
      }
    }
    const model = validateSelection(input.model, this.#config.allowedModels, 'model');
    if (!model.ok) throw new BridgeError('DSH_UNSUPPORTED', model.reason ?? 'model not allowed');
    const effort = validateSelection(input.reasoning_effort, this.#config.allowedReasoningEfforts, 'reasoning_effort');
    if (!effort.ok) throw new BridgeError('DSH_UNSUPPORTED', effort.reason ?? 'reasoning_effort not allowed');

    const response = (await client.request('session/new', {
      cwd: cwdDecision.cwd,
      mcpServers: [],
    })) as { sessionId?: unknown; configOptions?: unknown[] };
    const sessionId = response?.sessionId;
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new BridgeError('DSH_ACP_PROTOCOL', 'session/new returned no sessionId');
    }
    this.#sessions.set(sessionId, { sessionId, cwd: cwdDecision.cwd, createdAt: Date.now() });
    this.#created.add(sessionId);

    const configOptions = Array.isArray(response?.configOptions) ? response.configOptions : [];
    const appliedModel = model.value === undefined
      ? undefined
      : await this.#applySelection(client, sessionId, configOptions, 'model', 'model', model.value);
    const appliedEffort = effort.value === undefined
      ? undefined
      : await this.#applySelection(client, sessionId, configOptions, 'reasoning_effort', 'reasoning effort', effort.value);

    if (appliedModel !== undefined) await this.#setConfigOption(client, sessionId, 'model', appliedModel);
    if (appliedEffort !== undefined) await this.#setConfigOption(client, sessionId, 'reasoning_effort', appliedEffort);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ok: true,
              source: 'session/new',
              sessionId,
              cwd: cwdDecision.cwd,
              model: appliedModel ?? null,
              reasoning_effort: appliedEffort ?? null,
              configOptions,
              next: 'call dsh_send_message with this explicit session_id',
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  /**
   * Map a caller-facing selection onto the exact value the agent advertised.
   *
   * DSH advertises a model value as an opaque composite (for example
   * `["deepseek-official","deepseek-v4-flash"]`), so a bare model id must be
   * resolved through the advertised option names instead of being sent blind.
   */
  async #applySelection(
    client: AcpClient,
    sessionId: string,
    configOptions: unknown[],
    configId: string,
    label: string,
    requested: string,
  ): Promise<string> {
    const option = configOptions.find(
      (entry): entry is Record<string, unknown> =>
        entry !== null && typeof entry === 'object' && (entry as Record<string, unknown>).id === configId,
    );
    if (option === undefined) {
      throw new BridgeError(
        'DSH_UNSUPPORTED',
        `the agent does not advertise a ${label} configuration option (available: ${configOptions
          .map((entry) => String((entry as Record<string, unknown>).id))
          .join(', ')})`,
      );
    }
    const flat: Array<{ value?: unknown; name?: unknown }> = [];
    const rawOptions = Array.isArray(option.options) ? option.options : [];
    for (const entry of rawOptions) {
      if (entry === null || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      if (record.group !== undefined && Array.isArray(record.options)) {
        for (const nested of record.options) {
          if (nested !== null && typeof nested === 'object') flat.push(nested as { value?: unknown; name?: unknown });
        }
      } else {
        flat.push(record);
      }
    }
    const exact = flat.find((entry) => entry.value === requested);
    if (exact !== undefined) return requested;
    const byName = flat.filter((entry) => entry.name === requested);
    if (byName.length === 1 && typeof byName[0]?.value === 'string') return byName[0].value;
    throw new BridgeError(
      'DSH_UNSUPPORTED',
      `${label} ${JSON.stringify(requested)} is not advertised by the agent (available: ${flat
        .map((entry) => String(entry.name ?? entry.value))
        .join(', ')})`,
    );
  }

  async #setConfigOption(client: AcpClient, sessionId: string, configId: string, value: string): Promise<void> {
    try {
      await client.request('session/set_config_option', { sessionId, configId, value });
    } catch (error) {
      const normalized = normalizeAcpError(error);
      throw new BridgeError(normalized.code, `failed to set ${configId}: ${normalized.message}`, normalized.details);
    }
  }

  async #sendMessage(input: Record<string, unknown>): Promise<ToolCallOutcome> {
    const client = await this.#requireClient();
    const sessionId = readRequiredString(input.session_id, 'session_id');
    const text = readRequiredString(input.text, 'text');
    const policy = readPermissionPolicy(input.permission_policy);
    const timeoutMs = Math.min(
      readInteger(input.timeout_ms, this.#config.promptTimeoutMs, 1_000, Number.MAX_SAFE_INTEGER, 'timeout_ms'),
      this.#config.promptTimeoutMs,
    );

    const known = this.#sessions.get(sessionId);
    if (known === undefined) {
      throw new BridgeError(
        'DSH_SESSION_UNKNOWN',
        `session ${sessionId} is not active in this bridge; call dsh_create_session first (the bridge never defaults to "the most recent session" and does not resume prior sessions)`,
      );
    }
    if (this.#inflight.has(sessionId)) {
      throw new BridgeError(
        'DSH_SESSION_BUSY',
        `session ${sessionId} already has an in-flight prompt; wait for it or call dsh_cancel_session`,
      );
    }

    const collector = new TurnCollector({
      includeThoughts: this.#config.includeThoughts,
      maxChars: this.#config.maxOutputChars,
      maxToolChars: this.#config.maxOutputChars,
    });
    const abort = new AbortController();
    this.#inflight.set(sessionId, { policy, collector, abort });
    try {
      const promptResponse = (await client.request(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text }] },
        { timeoutMs, signal: abort.signal },
      )) as { stopReason?: unknown; usage?: unknown };
      const turn = collector.collect();
      const stopReason = typeof promptResponse?.stopReason === 'string' ? promptResponse.stopReason : 'unknown';
      const answer = {
        text: turn.assistantText,
        truncated: turn.assistantTruncated,
        originalChars: turn.assistantOriginalChars,
      };
      const thoughts = { text: turn.thoughts, truncated: turn.thoughtsTruncated };
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ok: true,
                source: 'session/prompt',
                session_id: sessionId,
                cwd: known.cwd,
                stop_reason: stopReason,
                assistant_text: answer.text,
                assistant_text_truncated: answer.truncated,
                assistant_text_original_chars: answer.originalChars,
                thoughts: thoughts.text === '' ? null : thoughts.text,
                thoughts_truncated: thoughts.truncated,
                thoughts_included: this.#config.includeThoughts,
                tool_calls: turn.toolCalls,
                truncated_tool_fields: turn.truncatedToolFields,
                usage: turn.usage ?? promptResponse?.usage ?? null,
                permission_policy: policy,
                permission_events: this.#permissionLog.filter((entry) => entry.sessionId === sessionId),
                unknown_update_kinds: turn.unknownUpdateKinds,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      if (error instanceof AcpTimeoutError) {
        // Stop the work we gave up on instead of leaving a runaway turn behind.
        client.notify('session/cancel', { sessionId });
        throw new BridgeError(
          'DSH_ACP_TIMEOUT',
          `prompt did not settle within ${timeoutMs}ms; a session/cancel was sent. The turn may still be winding down.`,
          { timeout_ms: timeoutMs },
        );
      }
      throw error;
    } finally {
      this.#inflight.delete(sessionId);
    }
  }

  async #cancelSession(input: Record<string, unknown>): Promise<ToolCallOutcome> {
    const client = await this.#requireClient();
    const sessionId = readRequiredString(input.session_id, 'session_id');
    if (!this.#sessions.has(sessionId)) {
      throw new BridgeError(
        'DSH_SESSION_UNKNOWN',
        `session ${sessionId} is not active in this bridge; nothing to cancel (DSH treats unknown session cancels as no-ops, so the bridge refuses instead of silently succeeding)`,
      );
    }
    client.notify('session/cancel', { sessionId });
    const wasInflight = this.#inflight.has(sessionId);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ok: true,
              source: 'session/cancel',
              session_id: sessionId,
              accepted: true,
              in_flight_prompt: wasInflight,
              note: wasInflight
                ? 'cancellation requested; the pending dsh_send_message settles with stop_reason "cancelled"'
                : 'no ACP prompt was in flight; the cancel targets autonomous work of this session only',
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  async #closeSession(input: Record<string, unknown>): Promise<ToolCallOutcome> {
    const client = await this.#requireClient();
    if (!client.supportsSessionClose) {
      throw new BridgeError('DSH_UNSUPPORTED', 'the agent did not advertise sessionCapabilities.close');
    }
    const sessionId = readRequiredString(input.session_id, 'session_id');
    if (input.confirm !== true) {
      throw new BridgeError(
        'DSH_INVALID_ARGUMENT',
        'dsh_close_session requires confirm=true: it cancels in-flight work, drains updates, releases the session run scope, and keeps persisted storage',
      );
    }
    if (!this.#sessions.has(sessionId)) {
      throw new BridgeError('DSH_SESSION_UNKNOWN', `session ${sessionId} is not active in this bridge`);
    }
    await client.request('session/close', { sessionId });
    this.#sessions.delete(sessionId);
    this.#inflight.delete(sessionId);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ok: true,
              source: 'session/close',
              session_id: sessionId,
              closed: true,
              persisted_storage_retained: true,
              note: 'the session scope was released; the bridge does not offer resume or transcript replay, so the persisted session is now dormant. Delete it with dsh_delete_session if it was created here and is no longer needed.',
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  async #deleteSession(input: Record<string, unknown>): Promise<ToolCallOutcome> {
    const sessionId = readRequiredString(input.session_id, 'session_id');
    if (input.confirm !== true) {
      throw new BridgeError(
        'DSH_INVALID_ARGUMENT',
        'dsh_delete_session requires confirm=true: it permanently removes the session\'s local persisted storage (this cannot be undone)',
      );
    }
    // The id becomes a directory name: refuse separators, dots, drive colons
    // and anything that could step outside the sessions root.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)) {
      throw new BridgeError(
        'DSH_INVALID_ARGUMENT',
        'session_id contains characters that are not valid in a DSH session directory name',
      );
    }
    if (!this.#created.has(sessionId)) {
      throw new BridgeError(
        'DSH_SESSION_NOT_DELETABLE',
        `session ${sessionId} was not created by this bridge process; only sessions created here can be deleted. DSH ACP has no delete method, so cross-process cleanup is an explicit manual operation: node scripts/prune-sessions.ts`,
      );
    }
    if (this.#inflight.has(sessionId)) {
      throw new BridgeError(
        'DSH_SESSION_BUSY',
        `session ${sessionId} has an in-flight prompt; wait for it or call dsh_cancel_session before deleting`,
      );
    }

    if (this.#sessions.has(sessionId)) {
      // Release the run scope first so no file handle is held by DSH when the
      // storage directory disappears. Deleting active sessions is what
      // confirm=true is for; the tool result reports that it closed first.
      const client = await this.#requireClient();
      if (!client.supportsSessionClose) {
        throw new BridgeError(
          'DSH_UNSUPPORTED',
          `session ${sessionId} is still active and the agent did not advertise sessionCapabilities.close; refusing to delete storage under an active session`,
        );
      }
      await client.request('session/close', { sessionId });
      this.#sessions.delete(sessionId);
      this.#logger.info(`closed active session ${sessionId} before deleting its storage`);
    }

    const home = this.#config.dshHome ?? defaultDshHome();
    const sessionsRoot = join(home, 'sessions');
    const found = findSessionDirectory(sessionsRoot, sessionId);
    if (found === undefined) {
      throw new BridgeError(
        'DSH_SESSION_STORAGE_NOT_FOUND',
        `no persisted session directory named ${sessionId} under ${sessionsRoot}`,
      );
    }
    rmSync(found, { recursive: true, force: false });
    this.#created.delete(sessionId);
    this.#logger.info(`deleted local session storage ${found}`);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ok: true,
              source: 'local filesystem (no ACP session/delete)',
              session_id: sessionId,
              deleted: true,
              path: relative(home, found),
              note: 'DSH ACP exposes no session/delete, so the bridge removed the persisted directory directly. Only sessions created by this bridge process can be deleted.',
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    for (const [sessionId] of this.#inflight) {
      try {
        this.#client?.notify('session/cancel', { sessionId });
      } catch {
        // ignore
      }
    }
    this.#client?.close();
    this.#client = undefined;
    const child = this.#process;
    this.#process = undefined;
    if (child !== undefined) await child.close(this.#config.closeTimeoutMs).catch(() => undefined);
  }
}

/** Locate `<DSH_HOME>/sessions/**\/<sessionId>` without trusting the cwd encoding. */
function findSessionDirectory(sessionsRoot: string, sessionId: string): string | undefined {
  if (!existsSync(sessionsRoot)) return undefined;
  const candidates = [join(sessionsRoot, sessionId)];
  try {
    for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(join(sessionsRoot, entry.name, sessionId));
    }
  } catch {
    return undefined;
  }
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // not this one
    }
  }
  return undefined;
}

function decidePermission(request: PermissionRequest, policy: 'deny' | 'allow_once'): PermissionDecision {
  const options = Array.isArray(request.options) ? request.options : [];
  if (policy === 'allow_once') {
    const allow = options.find((option) => option.kind === 'allow_once') ?? options.find((option) => option.optionId === 'allow-once');
    if (allow !== undefined) return { outcome: 'selected', optionId: allow.optionId };
  }
  const reject =
    options.find((option) => option.kind === 'reject_once' || option.kind === 'reject_always') ??
    options.find((option) => option.optionId === 'reject-once');
  if (reject !== undefined) return { outcome: 'selected', optionId: reject.optionId };
  // No reject option advertised: cancelling is the only non-approving answer.
  return { outcome: 'cancelled' };
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BridgeError('DSH_INVALID_ARGUMENT', `${field} is required and must be a non-empty string`);
  }
  return value;
}

function readOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new BridgeError('DSH_INVALID_ARGUMENT', `${field} must be a string`);
  return value;
}

function readInteger(value: unknown, fallback: number, min: number, max: number, field: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new BridgeError('DSH_INVALID_ARGUMENT', `${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function readPermissionPolicy(value: unknown): 'deny' | 'allow_once' {
  if (value === undefined || value === null) return 'deny';
  if (value === 'deny' || value === 'allow_once') return value;
  throw new BridgeError('DSH_INVALID_ARGUMENT', 'permission_policy must be "deny" or "allow_once"');
}
