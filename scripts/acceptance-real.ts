#!/usr/bin/env node
/**
 * Final acceptance: real DSH_HOME, dedicated throw-away sessions, REAL model prompt.
 *
 * v0.2.0 exposes no history access. Phase 1 creates a session, sends ONE
 * minimal real prompt and closes it. Phase 2 starts a fresh bridge process,
 * verifies the closed session's persisted directory still exists, then creates
 * and drives a NEW session (never list/resume).
 *
 * This spends a small amount of model tokens. It never touches the user's daily
 * sessions: both prompts go to sessions created by this script under
 * .tmp-tests/acceptance-work-*.
 *
 * Usage: node scripts/acceptance-real.ts --confirm-cost
 * Evidence: docs/reports/acceptance-real.json
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPORTS_DIR = join(PROJECT_ROOT, 'docs', 'reports');
const BRIDGE_ENTRY = join(PROJECT_ROOT, 'dist', 'index.js');
const DSH_HOME = process.env.DSH_HOME?.trim() || join(process.env.USERPROFILE ?? '', '.dsh');

const args = process.argv.slice(2);
if (!args.includes('--confirm-cost')) {
  console.error(
    [
      'acceptance-real: refusing to run without cost confirmation.',
      'This sends TWO minimal real prompts (phase 1 create+reply, phase 2 fresh create+reply).',
      'Re-run with: node scripts/acceptance-real.ts --confirm-cost',
    ].join('\n'),
  );
  process.exit(2);
}

const base = join(PROJECT_ROOT, '.tmp-tests');
mkdirSync(base, { recursive: true });
const workspace = mkdtempSync(join(base, 'acceptance-work-'));
const dshLauncher = join(
  process.env.LOCALAPPDATA ?? '',
  'Programs',
  'DeepSeek Harness',
  'resources',
  'runtime',
  'cli',
  'bin',
  'dsh.cmd',
);

interface Frame {
  id?: number | string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

const evidence: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  mode: 'real model prompt acceptance (dedicated sessions only)',
  dshHome: DSH_HOME,
  workspace,
  prompts: ['Reply with the single word: PONG', 'Reply with the single word: RESUMED'],
  steps: [] as unknown[],
};

function record(step: string, detail: unknown): void {
  (evidence.steps as unknown[]).push({ at: new Date().toISOString(), step, detail });
  console.log(`[accept] ${step}`, JSON.stringify(detail));
}

class Bridge {
  readonly frames: Frame[] = [];
  #nextId = 1;
  #exited = false;
  readonly proc;
  readonly #reader: ReturnType<typeof createInterface>;

  constructor(logName: string) {
    this.proc = spawn(process.execPath, [BRIDGE_ENTRY], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        DSH_CODEX_DSH_HOME: DSH_HOME,
        DSH_CODEX_ALLOWED_CWDS: workspace,
        DSH_CODEX_LOG_FILE: join(workspace, logName),
        DSH_CODEX_LOG_LEVEL: 'info',
        DSH_CODEX_CONNECT_TIMEOUT_MS: '180000',
        DSH_CODEX_PROMPT_TIMEOUT_MS: '300000',
        DSH_CODEX_TOOLS_LIST_WAIT_MS: '20000',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.#reader = createInterface({ input: this.proc.stdout!, crlfDelay: Number.POSITIVE_INFINITY });
    this.#reader.on('line', (line) => {
      if (line.trim() === '') return;
      try {
        this.frames.push(JSON.parse(line) as Frame);
      } catch {
        console.error('[accept] non-JSON stdout:', line.slice(0, 200));
      }
    });
    this.proc.stderr!.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    this.proc.on('exit', () => {
      this.#exited = true;
    });
  }

  async request(method: string, params: Record<string, unknown>, timeoutMs = 330_000): Promise<Frame> {
    const id = this.#nextId++;
    this.proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.frames.find((frame) => frame.id === id);
      if (found !== undefined) return found;
      if (this.#exited) throw new Error(`${method}: bridge exited before responding`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`${method} timed out after ${timeoutMs}ms`);
  }

  async callTool(name: string, toolArgs: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.request('tools/call', { name, arguments: toolArgs });
    if (response.error !== undefined) throw new Error(`${name}: JSON-RPC error ${JSON.stringify(response.error)}`);
    const content = (response.result?.content ?? []) as Array<{ type: string; text: string }>;
    return JSON.parse(content.map((block) => block.text).join('')) as Record<string, unknown>;
  }

  async close(): Promise<void> {
    this.proc.stdin!.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.proc.kill('SIGKILL');
        resolve();
      }, 20_000);
      this.proc.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.#reader.close();
  }
}

async function initialize(bridge: Bridge): Promise<void> {
  await bridge.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  bridge.proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
}

let sessionId = '';

async function phase1(): Promise<void> {
  const bridge = new Bridge('bridge-phase1.log');
  try {
    await initialize(bridge);
    const created = await bridge.callTool('dsh_create_session', { cwd: workspace });
    record('phase1 dsh_create_session', created);
    if (created.ok !== true) throw new Error(`create failed: ${JSON.stringify(created)}`);
    sessionId = String(created.sessionId);

    const prompt = 'Reply with the single word: PONG';
    const started = Date.now();
    const sent = await bridge.callTool('dsh_send_message', { session_id: sessionId, text: prompt });
    record('phase1 dsh_send_message (real model)', {
      ...sent,
      wall_ms: Date.now() - started,
    });
    if (sent.ok !== true) throw new Error(`prompt failed: ${JSON.stringify(sent)}`);
    evidence.phase1 = {
      sessionId,
      prompt,
      stop_reason: sent.stop_reason,
      assistant_text: sent.assistant_text,
      usage: sent.usage,
      thoughts_included: sent.thoughts_included,
      permission_events: sent.permission_events,
      wall_ms: sent.wall_ms,
    };

    const closed = await bridge.callTool('dsh_close_session', { session_id: sessionId, confirm: true });
    record('phase1 dsh_close_session (real release)', closed);
    if (closed.closed !== true) throw new Error(`close failed: ${JSON.stringify(closed)}`);
  } finally {
    await bridge.close();
  }
}

async function phase2(): Promise<void> {
  const bridge = new Bridge('bridge-phase2.log');
  try {
    await initialize(bridge);

    // The closed session must still be on disk; v0.2.0 never replays or resumes it.
    const persisted = findPersistedSession(sessionId);
    record('phase2 persisted session directory after close', {
      sessionId,
      exists: persisted !== undefined,
      path: persisted,
    });
    if (persisted === undefined) throw new Error(`persisted directory for ${sessionId} disappeared after close`);

    const created = await bridge.callTool('dsh_create_session', { cwd: workspace });
    record('phase2 dsh_create_session (fresh bridge process)', created);
    if (created.ok !== true) throw new Error(`create failed: ${JSON.stringify(created)}`);
    const newSessionId = String(created.sessionId);
    if (newSessionId === sessionId) throw new Error('a fresh bridge process must create a new session id');

    const prompt = 'Reply with the single word: RESUMED';
    const started = Date.now();
    const sent = await bridge.callTool('dsh_send_message', { session_id: newSessionId, text: prompt });
    record('phase2 dsh_send_message (real model)', { ...sent, wall_ms: Date.now() - started });
    if (sent.ok !== true) throw new Error(`prompt failed: ${JSON.stringify(sent)}`);
    evidence.phase2 = {
      newSessionId,
      prompt,
      stop_reason: sent.stop_reason,
      assistant_text: sent.assistant_text,
      usage: sent.usage,
      wall_ms: sent.wall_ms,
    };

    const closed = await bridge.callTool('dsh_close_session', { session_id: newSessionId, confirm: true });
    record('phase2 dsh_close_session', closed);
    evidence.ok = true;
  } finally {
    await bridge.close();
  }
}

/** Find `<DSH_HOME>/sessions/<group>/<id>` without reading any session content. */
function findPersistedSession(id: string): string | undefined {
  const sessionsRoot = join(DSH_HOME, 'sessions');
  try {
    for (const group of readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!group.isDirectory()) continue;
      const candidate = join(sessionsRoot, group.name, id);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

void (async () => {
  try {
    await phase1();
    record('phase1 bridge exited', { sessionId });
    await phase2();
  } catch (error) {
    evidence.ok = false;
    evidence.error = error instanceof Error ? error.message : String(error);
    console.error('[accept] FAILED:', evidence.error);
  } finally {
    evidence.finishedAt = new Date().toISOString();
    mkdirSync(REPORTS_DIR, { recursive: true });
    const outPath = join(REPORTS_DIR, 'acceptance-real.json');
    writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    console.log(`[accept] evidence written to ${outPath}`);
    if (!args.includes('--keep')) {
      try {
        rmSync(workspace, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // best effort
      }
    } else {
      console.log(`[accept] kept workspace=${workspace}`);
    }
    process.exit(evidence.ok === true ? 0 : 1);
  }
})();
