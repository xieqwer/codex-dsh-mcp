import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import { McpServer } from '../src/mcp-server.ts';
import { SessionBridge } from '../src/session-tools.ts';
import { makeConfig, makeTempDir, parseToolText, removeDir, silentLogger, waitFor } from './helpers.ts';

interface AnyFrame {
  id?: number | string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
  method?: string;
  params?: Record<string, unknown>;
}

class Harness {
  readonly frames: AnyFrame[] = [];
  readonly server: McpServer;
  readonly input = new PassThrough();
  readonly output = new PassThrough();
  #nextId = 1;
  readonly #reader: ReturnType<typeof createInterface>;

  constructor(bridge: SessionBridge) {
    this.server = new McpServer({
      input: this.input,
      output: this.output,
      bridge,
      logger: silentLogger,
      toolsListWaitMs: 3_000,
      shutdownBridgeOnClose: false,
    });
    this.#reader = createInterface({ input: this.output, crlfDelay: Number.POSITIVE_INFINITY });
    this.#reader.on('line', (line) => {
      if (line.trim() !== '') this.frames.push(JSON.parse(line) as AnyFrame);
    });
    this.server.start();
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.input.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  sendToolCall(name: string, args: Record<string, unknown>): number {
    const id = this.#nextId++;
    this.input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`,
    );
    return id;
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<AnyFrame> {
    const id = this.#nextId++;
    this.input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    await waitFor(() => this.frames.some((frame) => frame.id === id), 10_000, `${method} response`);
    return this.frames.find((frame) => frame.id === id)!;
  }

  async close(): Promise<void> {
    this.input.end();
    await this.server.whenClosed;
    this.#reader.close();
  }
}

let root: string;
let bridge: SessionBridge;

before(() => {
  root = makeTempDir('mcp');
  process.env.FAKE_ACP_LOG_FILE = join(root, 'acp-frames.jsonl');
  process.env.FAKE_ACP_SESSIONS_FILE = join(root, 'sessions.json');
  delete process.env.FAKE_ACP_MODE;
  bridge = new SessionBridge(makeConfig({ allowedCwds: [root] }), silentLogger);
});

after(async () => {
  await bridge.shutdown();
  removeDir(root);
});

test('MCP initialize negotiates a supported version and advertises tools', async () => {
  const harness = new Harness(bridge);
  try {
    const response = await harness.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'codex-test', version: '0.0.0' },
    });
    assert.equal(response.error, undefined);
    assert.equal(response.result?.protocolVersion, '2025-06-18');
    assert.equal(
      (response.result?.capabilities as Record<string, unknown>).tools !== undefined,
      true,
    );
    assert.equal((response.result?.serverInfo as Record<string, unknown>).name, 'codex-dsh-mcp');
    assert.match(String(response.result?.instructions), /explicit session_id/u);
  } finally {
    await harness.close();
  }
});

test('MCP initialize falls back to the newest supported version for an unknown request', async () => {
  const harness = new Harness(bridge);
  try {
    const response = await harness.request('initialize', { protocolVersion: '1999-01-01', capabilities: {} });
    assert.equal(response.result?.protocolVersion, '2025-06-18');
  } finally {
    await harness.close();
  }
});

test('tools/list exposes the six business tools and no generic ACP proxy', async () => {
  await bridge.ensureConnected();
  const harness = new Harness(bridge);
  try {
    await harness.request('initialize', { protocolVersion: '2025-06-18' });
    harness.notify('notifications/initialized');
    const response = await harness.request('tools/list');
    const tools = response.result?.tools as Array<Record<string, unknown>>;
    const names = tools.map((tool) => tool.name);
    assert.deepEqual(names, [
      'dsh_list_sessions',
      'dsh_create_session',
      'dsh_resume_session',
      'dsh_send_message',
      'dsh_cancel_session',
      'dsh_close_session',
    ]);
    for (const tool of tools) {
      assert.equal(tool.inputSchema !== undefined, true, `${String(tool.name)} has an input schema`);
      assert.equal(String(tool.description).length > 20, true);
    }
  } finally {
    await harness.close();
  }
});

test('ping answers immediately and an unknown tool is a JSON-RPC error', async () => {
  const harness = new Harness(bridge);
  try {
    const ping = await harness.request('ping');
    assert.deepEqual(ping.result, {});
    const unknown = await harness.request('tools/call', { name: 'dsh_rm_rf', arguments: {} });
    assert.equal(unknown.error?.code, -32602);
    assert.match(String(unknown.error?.message), /unknown tool/u);
  } finally {
    await harness.close();
  }
});

test('tools/call returns MCP content blocks and marks business failures with isError', async () => {
  const harness = new Harness(bridge);
  try {
    const created = await harness.request('tools/call', {
      name: 'dsh_create_session',
      arguments: { cwd: root },
    });
    const content = created.result?.content as Array<{ type: string; text: string }>;
    assert.equal(created.result?.isError, undefined);
    assert.equal(content[0]?.type, 'text');
    const createdBody = parseToolText({ content });
    assert.equal(createdBody.ok, true);
    const sessionId = String(createdBody.sessionId);

    const failed = await harness.request('tools/call', {
      name: 'dsh_send_message',
      arguments: { session_id: sessionId, text: 'hi', permission_policy: 'always' },
    });
    assert.equal(failed.result?.isError, true);
    const failedBody = parseToolText({ content: failed.result!.content as Array<{ type: string; text: string }> });
    assert.equal(failedBody.error?.code, 'DSH_INVALID_ARGUMENT');
  } finally {
    await harness.close();
  }
});

test('capability gating hides session/close when the agent does not advertise it', async () => {
  process.env.FAKE_ACP_MODE = 'no-close';
  try {
    await bridge.shutdown();
    bridge = new SessionBridge(makeConfig({ allowedCwds: [root] }), silentLogger);
    await bridge.ensureConnected();
    const harness = new Harness(bridge);
    try {
      await harness.request('initialize', { protocolVersion: '2025-06-18' });
      const response = await harness.request('tools/list');
      const names = (response.result?.tools as Array<Record<string, unknown>>).map((tool) => tool.name);
      assert.equal(names.includes('dsh_close_session'), false);
      assert.equal(names.includes('dsh_resume_session'), true);
    } finally {
      await harness.close();
    }
  } finally {
    delete process.env.FAKE_ACP_MODE;
  }
});

test('notification frames never carry an id and stdout is frame-only', async () => {
  await bridge.ensureConnected();
  const harness = new Harness(bridge);
  try {
    await harness.request('initialize', { protocolVersion: '2025-06-18' });
    harness.notify('notifications/initialized');
    await waitFor(
      () => harness.frames.some((frame) => frame.method === 'notifications/tools/list_changed'),
      8_000,
      'tools/list_changed notification',
    );
    const notification = harness.frames.find((frame) => frame.method === 'notifications/tools/list_changed')!;
    assert.equal(notification.id, undefined);
    for (const frame of harness.frames) {
      assert.equal(typeof frame === 'object' && frame !== null, true);
    }
  } finally {
    await harness.close();
  }
});

test('shutdown on stdin EOF releases the ACP child and refuses further connections', async () => {
  await bridge.shutdown();
  await assert.rejects(() => bridge.ensureConnected(), /shutting down/u);
});

function readAcpLog(): Array<{ kind?: string; frame?: { method?: string }; sessionId?: string }> {
  const file = process.env.FAKE_ACP_LOG_FILE;
  if (file === undefined || !existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { kind?: string; frame?: { method?: string }; sessionId?: string });
}

test('MCP request cancellation is forwarded to the ACP session', async () => {
  process.env.FAKE_ACP_MODE = 'slow-prompt';
  process.env.FAKE_ACP_PROMPT_DELAY_MS = '2500';
  const scratch = new SessionBridge(
    makeConfig({ allowedCwds: [root], promptTimeoutMs: 10_000 }),
    silentLogger,
  );
  try {
    const created = parseToolText(await scratch.call('dsh_create_session', { cwd: root }));
    const sessionId = String(created.sessionId);
    const harness = new Harness(scratch);
    try {
      await harness.request('initialize', { protocolVersion: '2025-06-18' });
      harness.notify('notifications/initialized');
      const requestId = harness.sendToolCall('dsh_send_message', { session_id: sessionId, text: 'slow' });
      await waitFor(
        () => readAcpLog().some((entry) => entry.kind === 'recv' && entry.frame?.method === 'session/prompt'),
        5_000,
        'session/prompt frame',
      );
      harness.notify('notifications/cancelled', { requestId, reason: 'user cancelled' });
      await waitFor(
        () => readAcpLog().some((entry) => entry.kind === 'session/cancel'),
        5_000,
        'forwarded session/cancel',
      );
    } finally {
      await harness.close();
    }
  } finally {
    delete process.env.FAKE_ACP_MODE;
    delete process.env.FAKE_ACP_PROMPT_DELAY_MS;
    await scratch.shutdown();
  }
});
