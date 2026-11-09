import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { SessionBridge } from '../src/session-tools.ts';
import {
  makeConfig,
  makeTempDir,
  parseToolText,
  removeDir,
  silentLogger,
  sleep,
  waitFor,
} from './helpers.ts';

interface LoggedFrame {
  kind: string;
  frame?: { method?: string; params?: Record<string, unknown> };
  sessionId?: string;
  text?: string;
  cwd?: string;
  returned?: number;
}

let root: string;
let logFile: string;
let sessionsFile: string;
let bridge: SessionBridge;
let sessionId: string;
let dshHome: string;

function readLog(): LoggedFrame[] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as LoggedFrame);
}

function received(method: string): LoggedFrame[] {
  return readLog().filter((entry) => entry.kind === 'recv' && entry.frame?.method === method);
}

/** Create the persisted directory a real DSH session/new would leave behind. */
function seedSessionStorage(home: string, id: string): string {
  const dir = join(home, 'sessions', '--D-Workspace-project--', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'events.jsonl'), '{"type":"start"}\n', 'utf8');
  return dir;
}

before(() => {
  root = makeTempDir('mapping');
  dshHome = join(root, 'dsh-home');
  logFile = join(root, 'acp-frames.jsonl');
  sessionsFile = join(root, 'sessions.json');
  process.env.FAKE_ACP_LOG_FILE = logFile;
  process.env.FAKE_ACP_SESSIONS_FILE = sessionsFile;
  delete process.env.FAKE_ACP_MODE;
  bridge = new SessionBridge(makeConfig({ allowedCwds: [root], dshHome }), silentLogger);
});

after(async () => {
  await bridge.shutdown();
  delete process.env.FAKE_ACP_LOG_FILE;
  delete process.env.FAKE_ACP_SESSIONS_FILE;
  removeDir(root);
});

test('session/new carries the canonical cwd and returns a session id', async () => {
  const outcome = await bridge.call('dsh_create_session', { cwd: root });
  const result = parseToolText(outcome);
  assert.equal(result.ok, true);
  assert.match(String(result.sessionId), /^fake-session-/u);
  sessionId = String(result.sessionId);

  await waitFor(() => received('session/new').length > 0, 5_000, 'session/new frame');
  const frame = received('session/new').at(-1)!;
  assert.equal(frame.frame?.params?.cwd, root);
  assert.deepEqual(frame.frame?.params?.mcpServers, []);
});

test('dsh_create_session refuses model selection when no allowlist is configured', async () => {
  const outcome = await bridge.call('dsh_create_session', { cwd: root, model: 'anything' });
  assert.equal(outcome.isError, true);
  const result = parseToolText(outcome);
  assert.equal(result.error?.code, 'DSH_UNSUPPORTED');
});

test('dsh_create_session refuses a different profile', async () => {
  const outcome = await bridge.call('dsh_create_session', { cwd: root, profile: 'web' });
  assert.equal(outcome.isError, true);
  const result = parseToolText(outcome);
  assert.equal(result.error?.code, 'DSH_UNSUPPORTED');
});

test('an allowlisted model id is mapped onto the agent-advertised composite value', async () => {
  const scratch = new SessionBridge(
    makeConfig({
      allowedCwds: [root],
      allowedModels: ['fake-model'],
      allowedReasoningEfforts: ['high'],
      dshHome,
    }),
    silentLogger,
  );
  try {
    const created = parseToolText(
      await scratch.call('dsh_create_session', { cwd: root, model: 'fake-model', reasoning_effort: 'high' }),
    );
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(created.model, '["fake-provider","fake-model"]');
    assert.equal(created.reasoning_effort, 'high');

    await sleep(400);
    const calls = readLog().filter((entry) => entry.kind === 'recv' && entry.frame?.method === 'session/set_config_option');
    assert.equal(
      calls.length >= 2,
      true,
      `set_config_option frames missing; recent log: ${JSON.stringify(readLog().slice(-8))}`,
    );
    const params = calls.map((entry) => entry.frame?.params as Record<string, unknown>);
    assert.equal(params[0].configId, 'model');
    assert.equal(params[0].value, '["fake-provider","fake-model"]');
    assert.equal(params[1].configId, 'reasoning_effort');
    assert.equal(params[1].value, 'high');
  } finally {
    await scratch.shutdown();
  }
});

test('an unknown model id is refused with the advertised choices', async () => {
  const scratch = new SessionBridge(
    makeConfig({ allowedCwds: [root], allowedModels: ['not-a-model'], dshHome }),
    silentLogger,
  );
  try {
    const outcome = await scratch.call('dsh_create_session', { cwd: root, model: 'not-a-model' });
    assert.equal(outcome.isError, true);
    const result = parseToolText(outcome);
    assert.equal(result.error?.code, 'DSH_UNSUPPORTED');
    assert.match(String(result.error?.message), /available: fake-model/u);
  } finally {
    await scratch.shutdown();
  }
});

test('session/prompt returns assistant text, tool calls and usage but never thoughts by default', async () => {
  const outcome = await bridge.call('dsh_send_message', { session_id: sessionId, text: 'hello acp' });
  const result = parseToolText(outcome);
  assert.equal(result.ok, true);
  assert.equal(result.stop_reason, 'end_turn');
  assert.equal(result.assistant_text, 'echo: hello acp');
  assert.equal(result.thoughts, null, 'DSH internal thoughts must not leak into the MCP result by default');
  assert.equal(result.thoughts_included, false);
  assert.equal(result.assistant_text_truncated, false);
  const toolCalls = result.tool_calls as Array<Record<string, unknown>>;
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].toolCallId, 'tool-1');
  assert.equal(toolCalls[0].status, 'completed');
  assert.equal((result.usage as Record<string, unknown>).totalTokens, 7);

  await waitFor(() => received('session/prompt').length > 0, 5_000, 'session/prompt frame');
  const frame = received('session/prompt').at(-1)!;
  assert.equal(frame.frame?.params?.sessionId, sessionId);
  assert.deepEqual(frame.frame?.params?.prompt, [{ type: 'text', text: 'hello acp' }]);
});

test('a second prompt for the same session is rejected while one is in flight', async () => {
  process.env.FAKE_ACP_MODE = 'slow-prompt';
  process.env.FAKE_ACP_PROMPT_DELAY_MS = '1500';
  try {
    // Restart the ACP child so the new mode takes effect.
    await bridge.shutdown();
    bridge = new SessionBridge(makeConfig({ allowedCwds: [root], promptTimeoutMs: 4_000, dshHome }), silentLogger);
    const created = parseToolText(await bridge.call('dsh_create_session', { cwd: root }));
    const slowId = String(created.sessionId);
    const first = bridge.call('dsh_send_message', { session_id: slowId, text: 'slow' });
    await waitFor(() => received('session/prompt').some((entry) => entry.frame?.params?.sessionId === slowId), 5_000, 'slow prompt frame');
    const busy = await bridge.call('dsh_send_message', { session_id: slowId, text: 'second' });
    assert.equal(busy.isError, true);
    assert.equal(parseToolText(busy).error?.code, 'DSH_SESSION_BUSY');
    const settled = parseToolText(await first);
    assert.equal(settled.assistant_text, 'echo: slow');
  } finally {
    delete process.env.FAKE_ACP_MODE;
    delete process.env.FAKE_ACP_PROMPT_DELAY_MS;
  }
});

test('dsh_send_message requires an active session and an explicit id', async () => {
  const unknown = await bridge.call('dsh_send_message', { session_id: 'does-not-exist', text: 'x' });
  assert.equal(unknown.isError, true);
  assert.equal(parseToolText(unknown).error?.code, 'DSH_SESSION_UNKNOWN');

  const missing = await bridge.call('dsh_send_message', { text: 'x' });
  assert.equal(missing.isError, true);
  assert.equal(parseToolText(missing).error?.code, 'DSH_INVALID_ARGUMENT');
});

test('session/close releases the session and keeps persisted storage', async () => {
  const created = parseToolText(await bridge.call('dsh_create_session', { cwd: root }));
  const id = String(created.sessionId);
  const closed = await bridge.call('dsh_close_session', { session_id: id, confirm: true });
  const result = parseToolText(closed);
  assert.equal(result.ok, true);
  assert.equal(result.closed, true);
  assert.equal(result.persisted_storage_retained, true);

  await waitFor(() => received('session/close').length > 0, 5_000, 'session/close frame');

  const afterClose = await bridge.call('dsh_send_message', { session_id: id, text: 'x' });
  assert.equal(parseToolText(afterClose).error?.code, 'DSH_SESSION_UNKNOWN');
});

test('session/close refuses to run without confirm=true', async () => {
  // Remove the slow-mode restart side effects by using a fresh session.
  const created = parseToolText(await bridge.call('dsh_create_session', { cwd: root }));
  const outcome = await bridge.call('dsh_close_session', { session_id: String(created.sessionId) });
  assert.equal(outcome.isError, true);
  const result = parseToolText(outcome);
  assert.equal(result.error?.code, 'DSH_INVALID_ARGUMENT');
  assert.match(String(result.error?.message), /confirm=true/u);
});

test('session/cancel targets exactly one session and reports whether a prompt is in flight', async () => {
  const created = parseToolText(await bridge.call('dsh_create_session', { cwd: root }));
  const id = String(created.sessionId);
  const outcome = await bridge.call('dsh_cancel_session', { session_id: id });
  const result = parseToolText(outcome);
  assert.equal(result.ok, true);
  assert.equal(result.accepted, true);
  assert.equal(result.in_flight_prompt, false);
  await waitFor(() => received('session/cancel').length > 0, 5_000, 'session/cancel frame');
  assert.equal(received('session/cancel').at(-1)!.frame?.params?.sessionId, id);

  const unknown = await bridge.call('dsh_cancel_session', { session_id: 'nope' });
  assert.equal(parseToolText(unknown).error?.code, 'DSH_SESSION_UNKNOWN');
});

test('permission requests are denied by default and allowed only when asked', async () => {
  process.env.FAKE_ACP_MODE = 'permission-request';
  try {
    await bridge.shutdown();
    bridge = new SessionBridge(makeConfig({ allowedCwds: [root], dshHome }), silentLogger);
    const created = parseToolText(await bridge.call('dsh_create_session', { cwd: root }));
    const id = String(created.sessionId);

    const denied = parseToolText(await bridge.call('dsh_send_message', { session_id: id, text: 'run' }));
    assert.match(String(denied.assistant_text), /reject-once/u);

    const allowed = parseToolText(
      await bridge.call('dsh_send_message', { session_id: id, text: 'run', permission_policy: 'allow_once' }),
    );
    assert.match(String(allowed.assistant_text), /allow-once/u);
  } finally {
    delete process.env.FAKE_ACP_MODE;
  }
});

test('thoughts are returned only when the operator opts in', async () => {
  const scratch = new SessionBridge(
    makeConfig({ allowedCwds: [root], includeThoughts: true, dshHome }),
    silentLogger,
  );
  try {
    const created = parseToolText(await scratch.call('dsh_create_session', { cwd: root }));
    const result = parseToolText(
      await scratch.call('dsh_send_message', { session_id: String(created.sessionId), text: 'opt in' }),
    );
    assert.equal(result.thoughts_included, true);
    assert.equal(result.thoughts, 'thinking about it');
  } finally {
    await scratch.shutdown();
  }
});

test('a stale tool history after a DSH upgrade is reported with actionable guidance', async () => {
  process.env.FAKE_ACP_MODE = 'defer-error';
  const scratch = new SessionBridge(makeConfig({ allowedCwds: [root], dshHome }), silentLogger);
  try {
    const created = parseToolText(await scratch.call('dsh_create_session', { cwd: root }));
    const sent = parseToolText(
      await scratch.call('dsh_send_message', { session_id: String(created.sessionId), text: 'go' }),
    );
    assert.equal(sent.ok, false);
    assert.equal(sent.error?.code, 'DSH_SESSION_TOOL_HISTORY_STALE');
    assert.match(String(sent.error?.message), /create a NEW session/u);
  } finally {
    delete process.env.FAKE_ACP_MODE;
    await scratch.shutdown();
  }
});

test('dsh_delete_session removes the persisted directory of a session created here', async () => {
  const scratch = new SessionBridge(makeConfig({ allowedCwds: [root], dshHome }), silentLogger);
  try {
    const created = parseToolText(await scratch.call('dsh_create_session', { cwd: root }));
    const id = String(created.sessionId);
    const dir = seedSessionStorage(dshHome, id);

    const outcome = await scratch.call('dsh_delete_session', { session_id: id, confirm: true });
    const result = parseToolText(outcome);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.deleted, true);
    assert.equal(result.path, join('sessions', '--D-Workspace-project--', id));
    assert.equal(existsSync(dir), false);

    // An active session is closed before its storage is removed.
    await waitFor(() => received('session/close').length > 0, 5_000, 'session/close before delete');
    assert.equal(received('session/close').at(-1)!.frame?.params?.sessionId, id);
  } finally {
    await scratch.shutdown();
  }
});

test('dsh_delete_session refuses to delete a session this process did not create', async () => {
  const scratch = new SessionBridge(makeConfig({ allowedCwds: [root], dshHome }), silentLogger);
  try {
    const created = parseToolText(await scratch.call('dsh_create_session', { cwd: root }));
    const other = String(created.sessionId);
    await scratch.shutdown();
    // A fresh bridge process starts with an empty created-set: it must refuse.
    const second = new SessionBridge(makeConfig({ allowedCwds: [root], dshHome }), silentLogger);
    try {
      const outcome = await second.call('dsh_delete_session', { session_id: other, confirm: true });
      assert.equal(outcome.isError, true);
      assert.equal(parseToolText(outcome).error?.code, 'DSH_SESSION_NOT_DELETABLE');
      assert.match(String(parseToolText(outcome).error?.message), /prune-sessions\.ts/u);
    } finally {
      await second.shutdown();
    }
  } finally {
    await scratch.shutdown();
  }
});

test('dsh_delete_session requires confirm=true', async () => {
  const scratch = new SessionBridge(makeConfig({ allowedCwds: [root], dshHome }), silentLogger);
  try {
    const created = parseToolText(await scratch.call('dsh_create_session', { cwd: root }));
    const outcome = await scratch.call('dsh_delete_session', { session_id: String(created.sessionId) });
    assert.equal(outcome.isError, true);
    const result = parseToolText(outcome);
    assert.equal(result.error?.code, 'DSH_INVALID_ARGUMENT');
    assert.match(String(result.error?.message), /confirm=true/u);
  } finally {
    await scratch.shutdown();
  }
});

test('dsh_delete_session rejects ids that could escape the sessions root', async () => {
  const scratch = new SessionBridge(makeConfig({ allowedCwds: [root], dshHome }), silentLogger);
  try {
    await scratch.call('dsh_create_session', { cwd: root });
    for (const id of ['../evil', '..\\evil', 'C:\\Windows', 'a/b']) {
      const outcome = await scratch.call('dsh_delete_session', { session_id: id, confirm: true });
      assert.equal(outcome.isError, true, `id ${id} must be rejected`);
      assert.equal(parseToolText(outcome).error?.code, 'DSH_INVALID_ARGUMENT');
    }
  } finally {
    await scratch.shutdown();
  }
});

test('dsh_delete_session reports missing storage instead of pretending success', async () => {
  const scratch = new SessionBridge(makeConfig({ allowedCwds: [root], dshHome }), silentLogger);
  try {
    const created = parseToolText(await scratch.call('dsh_create_session', { cwd: root }));
    const outcome = await scratch.call('dsh_delete_session', {
      session_id: String(created.sessionId),
      confirm: true,
    });
    assert.equal(outcome.isError, true);
    assert.equal(parseToolText(outcome).error?.code, 'DSH_SESSION_STORAGE_NOT_FOUND');
  } finally {
    await scratch.shutdown();
  }
});
