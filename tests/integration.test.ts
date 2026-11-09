import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import {
  FAKE_SERVER,
  PROJECT_ROOT,
  makeTempDir,
  parseToolText,
  removeDir,
  waitFor,
} from './helpers.ts';

/**
 * End-to-end over real stdio processes:
 * test → bridge child (`node src/index.ts`) → fake DSH ACP child.
 *
 * v0.2.0 exposes no history access: a restarted bridge creates and drives a
 * fresh session. It never lists or resumes the previous process's session.
 */

const BRIDGE_ENTRY = join(PROJECT_ROOT, 'src', 'index.ts');

interface RpcFrame {
  id?: number | string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
  method?: string;
}

class BridgeProcess {
  readonly frames: RpcFrame[] = [];
  #nextId = 1;
  #closed = false;
  readonly proc;
  readonly #reader: ReturnType<typeof createInterface>;

  constructor(env: Record<string, string>) {
    this.proc = spawn(process.execPath, [BRIDGE_ENTRY], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.#reader = createInterface({ input: this.proc.stdout!, crlfDelay: Number.POSITIVE_INFINITY });
    this.#reader.on('line', (line) => {
      if (line.trim() === '') return;
      this.frames.push(JSON.parse(line) as RpcFrame);
    });
    this.proc.stderr!.on('data', () => {
      // stderr is diagnostic; keep draining it so the child never blocks.
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<RpcFrame> {
    const id = this.#nextId++;
    this.proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    await waitFor(() => this.frames.some((frame) => frame.id === id), 20_000, `${method} response`);
    return this.frames.find((frame) => frame.id === id)!;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; body: Record<string, unknown> }> {
    const response = await this.request('tools/call', { name, arguments: args });
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    const content = (response.result?.content ?? []) as Array<{ type: string; text: string }>;
    return {
      ...(response.result?.isError === true ? { isError: true } : {}),
      body: parseToolText({ content }),
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.proc.stdin!.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.proc.kill('SIGKILL');
        resolve();
      }, 10_000);
      this.proc.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.#reader.close();
  }
}

let root: string;
let bridgeLog: string;
let sessionsFile: string;

function bridgeEnv(): Record<string, string> {
  return {
    DSH_CODEX_DSH_COMMAND: process.execPath,
    DSH_CODEX_DSH_ARGS_JSON: JSON.stringify([FAKE_SERVER]),
    DSH_CODEX_ALLOWED_CWDS: root,
    DSH_CODEX_LOG_FILE: bridgeLog,
    DSH_CODEX_LOG_LEVEL: 'info',
    DSH_CODEX_TOOLS_LIST_WAIT_MS: '5000',
    DSH_CODEX_MAX_OUTPUT_CHARS: '4000',
    FAKE_ACP_LOG_FILE: join(root, 'acp-frames.jsonl'),
    FAKE_ACP_SESSIONS_FILE: sessionsFile,
  };
}

before(() => {
  root = makeTempDir('integration');
  bridgeLog = join(root, 'bridge.log');
  sessionsFile = join(root, 'sessions.json');
  delete process.env.FAKE_ACP_MODE;
});

after(() => {
  removeDir(root);
});

test('bridge process A creates a session and gets an assistant reply over ACP', async () => {
  const bridge = new BridgeProcess(bridgeEnv());
  try {
    const init = await bridge.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'codex-integration', version: '0.0.0' },
    });
    assert.equal(init.result?.protocolVersion, '2025-06-18');
    bridge.notify('notifications/initialized');

    const listTools = await bridge.request('tools/list');
    const names = (listTools.result?.tools as Array<Record<string, unknown>>).map((tool) => tool.name);
    assert.equal(names.length, 5);

    const created = await bridge.callTool('dsh_create_session', { cwd: root });
    assert.equal(created.body.ok, true);
    const sessionId = String(created.body.sessionId);

    const sent = await bridge.callTool('dsh_send_message', { session_id: sessionId, text: 'integration hello' });
    assert.equal(sent.body.assistant_text, 'echo: integration hello');
    assert.equal(sent.body.stop_reason, 'end_turn');

    // Persist what window B needs to assert.
    process.env.DSH_CODEX_TEST_SESSION = sessionId;
  } finally {
    await bridge.close();
  }
  await waitFor(() => existsSync(bridgeLog), 5_000, 'bridge log file');
  const log = readFileSync(bridgeLog, 'utf8');
  assert.match(log, /connected to dsh acp/u);
  assert.match(log, /mcp tools\/call dsh_create_session/u);
});

test('a new bridge process can create and drive a fresh session after the first exits', async () => {
  const bridge = new BridgeProcess(bridgeEnv());
  try {
    await bridge.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    bridge.notify('notifications/initialized');

    const created = await bridge.callTool('dsh_create_session', { cwd: root });
    assert.equal(created.body.ok, true, JSON.stringify(created.body));
    const sessionId = String(created.body.sessionId);
    assert.notEqual(sessionId, process.env.DSH_CODEX_TEST_SESSION, 'a restarted bridge must create a new session');

    const sent = await bridge.callTool('dsh_send_message', { session_id: sessionId, text: 'second window' });
    assert.equal(sent.body.assistant_text, 'echo: second window');

    // A dedicated process may close the session it owns; no history is replayed.
    const closed = await bridge.callTool('dsh_close_session', { session_id: sessionId, confirm: true });
    assert.equal(closed.body.closed, true);
  } finally {
    await bridge.close();
  }
});

test('all test traffic stayed inside the temporary DSH fixture directory', () => {
  const acpFrames = join(root, 'acp-frames.jsonl');
  assert.equal(existsSync(acpFrames), true);
  const frames = readFileSync(acpFrames, 'utf8');
  assert.match(frames, /integration hello/u);
  // No real DSH home was used: the fake peer only ever saw this temp root.
  assert.equal(frames.includes('.dsh\\sessions') || frames.includes('.dsh/sessions'), false);
});
