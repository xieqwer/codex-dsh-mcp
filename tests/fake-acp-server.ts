#!/usr/bin/env node
/**
 * A fake DSH ACP peer for tests.
 *
 * It speaks the same newline-delimited JSON-RPC framing as `dsh --profile acp`
 * and implements the subset the bridge uses. Behaviour is selected through
 * environment variables so a test can assert request mapping, pagination,
 * permission handling, timeouts, cancellation and crashes without touching the
 * user's real DSH installation or session store.
 *
 * Env:
 *   FAKE_ACP_MODE            normal | no-list | no-resume | no-close | slow-prompt | crash-on-prompt | permission-request | defer-error
 *   FAKE_ACP_LOG_FILE        append every received/answered frame here (JSON lines)
 *   FAKE_ACP_SESSIONS_FILE   persisted session list shared across process restarts
 *   FAKE_ACP_PAGE_SIZE       session/list page size (default 2)
 *   FAKE_ACP_PROMPT_DELAY_MS delay before a prompt settles (default 5000 in slow mode)
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

type Json = Record<string, unknown>;

interface FakeSession {
  sessionId: string;
  cwd: string;
}

const mode = process.env.FAKE_ACP_MODE ?? 'normal';
const logFile = process.env.FAKE_ACP_LOG_FILE;
const sessionsFile = process.env.FAKE_ACP_SESSIONS_FILE;
const pageSize = Number(process.env.FAKE_ACP_PAGE_SIZE ?? '2');
const promptDelayMs = Number(process.env.FAKE_ACP_PROMPT_DELAY_MS ?? '5000');

const args = process.argv.slice(2);
if (args.includes('--help')) {
  // Mirrors the real launcher: help exits without claiming stdin/stdout.
  process.stdout.write('fake dsh acp server\noptions:\n  --profile <name>\n');
  process.exit(0);
}
log({ kind: 'start', args, mode });

let nextSessionNumber = 1;
let nextRequestId = 1000;
const pendingServerRequests = new Map<number, (result: unknown) => void>();
const prompts = new Map<string, { cancelled: boolean; timer?: NodeJS.Timeout }>();

function log(entry: Json): void {
  if (logFile === undefined || logFile === '') return;
  try {
    appendFileSync(logFile, `${JSON.stringify({ at: Date.now(), ...entry })}\n`, 'utf8');
  } catch {
    // A test log failure must not kill the fake server.
  }
}

function readSessions(): FakeSession[] {
  if (sessionsFile === undefined || sessionsFile === '' || !existsSync(sessionsFile)) return [];
  try {
    const parsed = JSON.parse(readFileSync(sessionsFile, 'utf8'));
    return Array.isArray(parsed) ? (parsed as FakeSession[]) : [];
  } catch {
    return [];
  }
}

function writeSessions(sessions: FakeSession[]): void {
  if (sessionsFile === undefined || sessionsFile === '') return;
  writeFileSync(sessionsFile, JSON.stringify(sessions, null, 2), 'utf8');
}

function send(frame: Json): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function respond(id: unknown, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id: unknown, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function notify(method: string, params: unknown): void {
  send({ jsonrpc: '2.0', method, params });
}

function request(method: string, params: unknown): Promise<unknown> {
  const id = nextRequestId++;
  return new Promise((resolve) => {
    pendingServerRequests.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });
}

function capabilities(): Json {
  const sessionCapabilities: Json = {
    list: mode === 'no-list' ? undefined : {},
    resume: mode === 'no-resume' ? undefined : {},
    close: mode === 'no-close' ? undefined : {},
  };
  for (const key of Object.keys(sessionCapabilities)) {
    if (sessionCapabilities[key] === undefined) delete sessionCapabilities[key];
  }
  return {
    mcpCapabilities: { http: true },
    promptCapabilities: { image: false, audio: false, embeddedContext: false },
    sessionCapabilities,
  };
}

function handleInitialize(id: unknown): void {
  respond(id, {
    protocolVersion: 1,
    agentInfo: { name: 'fake-dsh-acp', version: '0.0.0-test' },
    agentCapabilities: capabilities(),
    authMethods: [],
  });
}

function handleNewSession(id: unknown, params: Json): void {
  const cwd = params.cwd;
  if (typeof cwd !== 'string' || cwd === '') {
    respondError(id, -32602, 'cwd must be an absolute path: undefined');
    return;
  }
  if (process.platform === 'win32' ? !/^[a-zA-Z]:[\\/]/u.test(cwd) : !cwd.startsWith('/')) {
    respondError(id, -32602, `cwd must be an absolute path: ${cwd}`);
    return;
  }
  const sessionId = `fake-session-${nextSessionNumber++}`;
  writeSessions([...readSessions(), { sessionId, cwd }]);
  log({ kind: 'session/new', sessionId, cwd, mcpServers: params.mcpServers });
  respond(id, {
    sessionId,
    configOptions: [
      {
        type: 'select',
        id: 'model',
        name: 'Model',
        category: 'model',
        currentValue: '["fake-provider","fake-model"]',
        options: [
          {
            group: 'fake-provider',
            name: 'Fake provider',
            options: [{ value: '["fake-provider","fake-model"]', name: 'fake-model' }],
          },
        ],
      },
      {
        type: 'select',
        id: 'reasoning_effort',
        name: 'Reasoning effort',
        category: 'thought_level',
        currentValue: 'high',
        options: [
          { value: 'off', name: 'Off' },
          { value: 'high', name: 'High' },
        ],
      },
    ],
  });
}

function handleListSessions(id: unknown, params: Json): void {
  const all = readSessions();
  const cwd = typeof params.cwd === 'string' ? params.cwd : undefined;
  const filtered = cwd === undefined ? all : all.filter((entry) => entry.cwd.toLowerCase() === cwd.toLowerCase());
  const offset = typeof params.cursor === 'string' ? Number(params.cursor) : 0;
  const start = Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
  const page = filtered.slice(start, start + pageSize);
  const nextOffset = start + page.length;
  respond(id, {
    sessions: page.map((entry) => ({ sessionId: entry.sessionId, cwd: entry.cwd })),
    nextCursor: nextOffset < filtered.length ? String(nextOffset) : null,
  });
  log({ kind: 'session/list', cwd: params.cwd, cursor: params.cursor, returned: page.length });
}

function handleResumeSession(id: unknown, params: Json): void {
  const sessionId = params.sessionId;
  const cwd = params.cwd;
  const sessions = readSessions();
  const found = sessions.find((entry) => entry.sessionId === sessionId);
  if (found === undefined) {
    respondError(id, -32602, `session is not resumable: ${String(sessionId)}`);
    return;
  }
  if (typeof cwd !== 'string' || found.cwd.toLowerCase() !== cwd.toLowerCase()) {
    respondError(id, -32602, `session cwd does not match: ${String(cwd)}`);
    return;
  }
  log({ kind: 'session/resume', sessionId, cwd });
  respond(id, { configOptions: [] });
}

function handlePrompt(id: unknown, params: Json): void {
  const sessionId = params.sessionId;
  if (typeof sessionId !== 'string' || sessionId === '') {
    respondError(id, -32602, `unknown session: ${String(sessionId)}`);
    return;
  }
  const state = { cancelled: false } as { cancelled: boolean; timer?: NodeJS.Timeout };
  prompts.set(sessionId, state);
  const text = extractPromptText(params.prompt);
  log({ kind: 'session/prompt', sessionId, text });

  const finish = async (): Promise<void> => {
    if (mode === 'crash-on-prompt') {
      log({ kind: 'crash', sessionId });
      process.exit(3);
    }
    if (mode === 'defer-error') {
      prompts.delete(sessionId);
      respondError(
        id,
        -32603,
        'Internal error: turn failed: tools: at least one tool must have defer_loading=false. All tools cannot be deferred. (request_id: fake-defer)',
      );
      return;
    }
    if (state.cancelled) {
      prompts.delete(sessionId);
      respond(id, { stopReason: 'cancelled' });
      return;
    }
    if (mode === 'permission-request') {
      const permission = await request('session/request_permission', {
        sessionId,
        toolCall: { toolCallId: 'tool-1', title: 'run tests' },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      });
      log({ kind: 'permission/response', sessionId, permission });
      notify('session/update', {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `permission:${JSON.stringify(permission)}` },
        },
      });
      prompts.delete(sessionId);
      respond(id, { stopReason: 'end_turn' });
      return;
    }

    notify('session/update', {
      sessionId,
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking about it' } },
    });
    notify('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'echo',
        kind: 'other',
        status: 'in_progress',
      },
    });
    notify('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        status: 'completed',
        rawOutput: { echoed: text },
      },
    });
    notify('session/update', {
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `echo: ${text}` } },
    });
    notify('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'usage_update',
        usage: { totalTokens: 7, inputTokens: 5, outputTokens: 2 },
      },
    });
    prompts.delete(sessionId);
    respond(id, { stopReason: 'end_turn' });
  };

  const delayMs = mode === 'slow-prompt' ? promptDelayMs : 5;
  state.timer = setTimeout(() => {
    void finish();
  }, delayMs);
}

function handleCancel(params: Json): void {
  const sessionId = params.sessionId;
  log({ kind: 'session/cancel', sessionId });
  if (typeof sessionId !== 'string') return;
  const state = prompts.get(sessionId);
  if (state !== undefined) {
    state.cancelled = true;
    if (state.timer !== undefined) clearTimeout(state.timer);
    // The prompt response is emitted by the next settle, mirroring a cooperative cancel.
    prompts.delete(sessionId);
    notify('session/update', {
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'cancelled' } },
    });
  }
}

function handleClose(id: unknown, params: Json): void {
  log({ kind: 'session/close', sessionId: params.sessionId });
  respond(id, {});
}

function extractPromptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return '';
  return prompt
    .filter((block): block is Json => block !== null && typeof block === 'object')
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('');
}

function handleMessage(frame: Json): void {
  log({ kind: 'recv', frame: { method: frame.method, id: frame.id, params: frame.params } });

  if (frame.method === undefined) {
    // A response to one of our server-initiated requests (permission prompts).
    if (typeof frame.id === 'number') {
      const settle = pendingServerRequests.get(frame.id);
      if (settle !== undefined) {
        pendingServerRequests.delete(frame.id);
        settle(frame.result ?? frame.error ?? null);
      }
    }
    return;
  }

  const id = frame.id;
  const params = (frame.params ?? {}) as Json;
  switch (frame.method) {
    case 'initialize':
      handleInitialize(id);
      return;
    case 'session/new':
      handleNewSession(id, params);
      return;
    case 'session/list':
      handleListSessions(id, params);
      return;
    case 'session/resume':
      handleResumeSession(id, params);
      return;
    case 'session/prompt':
      handlePrompt(id, params);
      return;
    case 'session/cancel': {
      handleCancel(params);
      return;
    }
    case 'session/close':
      handleClose(id, params);
      return;
    case 'session/set_config_option':
      log({ kind: 'session/set_config_option', params });
      respond(id, { configOptions: [] });
      return;
    default:
      respondError(id, -32601, `method not found: ${String(frame.method)}`);
  }
}

const reader = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
reader.on('line', (line) => {
  if (line.trim() === '') return;
  let frame: Json;
  try {
    frame = JSON.parse(line) as Json;
  } catch {
    log({ kind: 'parse-error', line });
    return;
  }
  handleMessage(frame);
});
reader.on('close', () => {
  log({ kind: 'stdin-closed' });
  process.exit(0);
});
