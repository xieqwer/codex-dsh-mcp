import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { AcpProcess } from '../src/acp-process.ts';
import { SessionBridge } from '../src/session-tools.ts';
import {
  FAKE_SERVER,
  makeConfig,
  makeTempDir,
  parseToolText,
  removeDir,
  silentLogger,
  sleep,
  waitFor,
} from './helpers.ts';

let root: string;

before(() => {
  root = makeTempDir('lifecycle');
});

after(() => {
  delete process.env.FAKE_ACP_MODE;
  removeDir(root);
});

test('the launcher-style child exits cleanly for --help without claiming stdin', async () => {
  const child = new AcpProcess({
    command: process.execPath,
    args: [FAKE_SERVER, '--help'],
    env: { ...process.env },
    logger: silentLogger,
  });
  child.start();
  await waitFor(() => child.exitInfo !== undefined, 8_000, 'help exit');
  assert.equal(child.exitInfo?.code, 0);
  await child.close(2_000);
});

test('a crashing ACP child fails the in-flight prompt with a diagnosable error', async () => {
  process.env.FAKE_ACP_MODE = 'crash-on-prompt';
  const bridge = new SessionBridge(makeConfig({ allowedCwds: [root] }), silentLogger);
  try {
    const created = parseToolText(await bridge.call('dsh_create_session', { cwd: root }));
    const sessionId = String(created.sessionId);
    const outcome = await bridge.call('dsh_send_message', { session_id: sessionId, text: 'crash now' });
    assert.equal(outcome.isError, true);
    const result = parseToolText(outcome);
    assert.equal(result.error?.code, 'DSH_ACP_UNAVAILABLE');
    assert.match(String(result.error?.message), /exited|stdout closed/u);
  } finally {
    await bridge.shutdown();
  }
});

test('a crashed child can be restarted and the bridge recovers', async () => {
  process.env.FAKE_ACP_MODE = 'crash-on-prompt';
  const bridge = new SessionBridge(makeConfig({ allowedCwds: [root] }), silentLogger);
  try {
    const created = parseToolText(await bridge.call('dsh_create_session', { cwd: root }));
    const sessionId = String(created.sessionId);
    await bridge.call('dsh_send_message', { session_id: sessionId, text: 'boom' });
    assert.equal(bridge.connected, false);

    delete process.env.FAKE_ACP_MODE;
    // The bridge cools down after a failed connect/exit to avoid restart storms.
    await sleep(3_200);
    const recovered = parseToolText(await bridge.call('dsh_create_session', { cwd: root }));
    assert.equal(recovered.ok, true);
    assert.match(String(recovered.sessionId), /^fake-session-/u);
  } finally {
    delete process.env.FAKE_ACP_MODE;
    await bridge.shutdown();
  }
});

test('shutdown terminates the child and later tool calls are refused', async () => {
  const bridge = new SessionBridge(makeConfig({ allowedCwds: [root] }), silentLogger);
  await bridge.ensureConnected();
  assert.equal(bridge.connected, true);
  await bridge.shutdown();
  assert.equal(bridge.connected, false);
  const outcome = await bridge.call('dsh_create_session', { cwd: root });
  assert.equal(outcome.isError, true);
  assert.equal(parseToolText(outcome).error?.code, 'DSH_BRIDGE_SHUTDOWN');
});

test('a missing executable reports DSH_ACP_UNAVAILABLE and does not hang', async () => {
  const bridge = new SessionBridge(
    makeConfig({
      dshCommand: process.execPath,
      dshArgs: [FAKE_SERVER],
      allowedCwds: [root],
      connectTimeoutMs: 2_000,
    }),
    silentLogger,
  );
  const config = bridge;
  // Force a spawn failure by pointing the command at a directory.
  const broken = new SessionBridge(
    makeConfig({ dshCommand: root, dshArgs: [], allowedCwds: [root], connectTimeoutMs: 2_000 }),
    silentLogger,
  );
  try {
    const outcome = await broken.call('dsh_create_session', { cwd: root });
    assert.equal(outcome.isError, true);
    const result = parseToolText(outcome);
    assert.equal(result.error?.code, 'DSH_ACP_UNAVAILABLE');
  } finally {
    await broken.shutdown();
    await config.shutdown();
  }
});
