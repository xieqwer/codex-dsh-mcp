#!/usr/bin/env node
/**
 * Validate that real, desktop-created sessions can be listed, resumed and
 * continued through the bridge — without touching sessions that may still be
 * held by the desktop app.
 *
 * There are NO hard-coded session ids: pass them explicitly, after confirming
 * in the desktop app that they are closed (not merely background tabs).
 *
 * Usage:
 *   node scripts/acceptance-desktop-sessions.ts \
 *     --session session-<id> --cwd 'D:\work\project-a' --kind execution \
 *     --session session-<id> --cwd 'E:\work\topic-b'   --kind decision
 *
 * Each target must also appear in `dsh_list_sessions` with the exact cwd before
 * it is resumed. This script deliberately does NOT call dsh_close_session; the
 * sessions stay persisted and connection teardown only releases the run scope.
 *
 * Evidence: docs/reports/acceptance-desktop-sessions.json
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPORTS_DIR = join(PROJECT_ROOT, 'docs', 'reports');
const BRIDGE_ENTRY = join(PROJECT_ROOT, 'dist', 'index.js');
const DSH_HOME = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');

interface Target {
  kind: string;
  sessionId: string;
  cwd: string;
  prompt: string;
}

function parseTargets(argv: string[]): Target[] {
  const targets: Target[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--session') continue;
    const sessionId = argv[i + 1];
    const cwdIndex = argv.indexOf('--cwd', i + 2);
    const kindIndex = argv.indexOf('--kind', i + 2);
    const cwd = cwdIndex >= 0 ? argv[cwdIndex + 1] : undefined;
    const kind = kindIndex >= 0 ? argv[kindIndex + 1] : 'execution';
    if (sessionId === undefined || cwd === undefined) {
      throw new Error('each --session needs a following --cwd');
    }
    const label = kind === 'decision' ? 'DECIDE-OK' : 'EXEC-OK';
    targets.push({
      kind,
      sessionId,
      cwd,
      prompt: `Reply with the single word: ${label}. Do not call any tools or modify any files.`,
    });
  }
  return targets;
}

const targets = parseTargets(process.argv.slice(2));
if (targets.length === 0) {
  console.error(
    [
      'acceptance-desktop-sessions: refusing to run without explicit targets.',
      '',
      'Pass sessions that you have confirmed are closed in the desktop app:',
      "  node scripts/acceptance-desktop-sessions.ts --session session-<id> --cwd 'D:\\work\\project-a' --kind execution",
      '',
      'This script RESUME + SENDS A REAL MODEL PROMPT into those sessions (spends tokens)',
      'and does not close them afterwards.',
    ].join('\n'),
  );
  process.exit(2);
}
const notFoundCwd = targets.filter((target) => !statSync(target.cwd, { throwIfNoEntry: false })?.isDirectory());
if (notFoundCwd.length > 0) {
  console.error(`acceptance-desktop-sessions: cwd does not exist: ${notFoundCwd.map((t) => t.cwd).join(', ')}`);
  process.exit(2);
}

interface Frame {
  id?: number | string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

const evidence: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  mode: 'real desktop-created inactive sessions: list -> resume -> send_message (no close)',
  dshHome: DSH_HOME,
  targets: targets.map((t) => ({ kind: t.kind, sessionId: t.sessionId, cwd: t.cwd })),
  results: [] as unknown[],
  steps: [] as unknown[],
};

function record(step: string, detail: unknown): void {
  (evidence.steps as unknown[]).push({ at: new Date().toISOString(), step, detail });
  console.log(`[sess] ${step}`, JSON.stringify(detail));
}

const logFile = join(PROJECT_ROOT, '.codex-dsh-mcp.acceptance.log');
const bridge = spawn(process.execPath, [BRIDGE_ENTRY], {
  cwd: PROJECT_ROOT,
  env: {
    ...process.env,
    DSH_CODEX_DSH_HOME: DSH_HOME,
    DSH_CODEX_ALLOWED_CWDS: targets.map((t) => t.cwd).join(';'),
    DSH_CODEX_LOG_FILE: logFile,
    DSH_CODEX_LOG_LEVEL: 'info',
    DSH_CODEX_CONNECT_TIMEOUT_MS: '180000',
    DSH_CODEX_PROMPT_TIMEOUT_MS: '300000',
    DSH_CODEX_TOOLS_LIST_WAIT_MS: '20000',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

const frames: Frame[] = [];
const reader = createInterface({ input: bridge.stdout!, crlfDelay: Number.POSITIVE_INFINITY });
reader.on('line', (line) => {
  if (line.trim() === '') return;
  try {
    frames.push(JSON.parse(line) as Frame);
  } catch {
    console.error('[sess] non-JSON stdout:', line.slice(0, 200));
  }
});
bridge.stderr!.on('data', (chunk: Buffer) => process.stderr.write(chunk));

let nextId = 1;
async function request(method: string, params: Record<string, unknown>, timeoutMs = 330_000): Promise<Frame> {
  const id = nextId++;
  bridge.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = frames.find((frame) => frame.id === id);
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${method} timed out after ${timeoutMs}ms`);
}

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await request('tools/call', { name, arguments: args });
  if (response.error !== undefined) throw new Error(`${name}: JSON-RPC error ${JSON.stringify(response.error)}`);
  const content = (response.result?.content ?? []) as Array<{ type: string; text: string }>;
  return JSON.parse(content.map((block) => block.text).join('')) as Record<string, unknown>;
}

function sessionFileMtime(sessionId: string): string | null {
  // Read-only metadata check: locate the session directory and report its newest file time.
  const sessionsDir = join(DSH_HOME, 'sessions');
  if (!existsSync(sessionsDir)) return null;
  try {
    for (const group of readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!group.isDirectory()) continue;
      const dir = join(sessionsDir, group.name, sessionId);
      if (!existsSync(dir)) continue;
      const files = readdirSync(dir).map((name) => statSync(join(dir, name)).mtime.toISOString());
      return files.sort().at(-1) ?? null;
    }
  } catch {
    return null;
  }
  return null;
}

async function main(): Promise<void> {
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  bridge.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);

  // 1) List all sessions and confirm both targets are visible (read-only).
  const listed: Array<Record<string, unknown>> = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page += 1) {
    const response = await callTool('dsh_list_sessions', { limit: 100, ...(cursor === null ? {} : { cursor }) });
    if (response.ok !== true) throw new Error(`list failed: ${JSON.stringify(response)}`);
    for (const entry of (response.sessions as Array<Record<string, unknown>>) ?? []) listed.push(entry);
    const next = response.nextCursor;
    if (typeof next !== 'string' || next === '' || response.hasMore !== true) break;
    cursor = next;
  }
  const listedIds = new Set(listed.map((entry) => String(entry.sessionId)));
  record('1. dsh_list_sessions', { count: listed.length, hasBothTargets: targets.every((t) => listedIds.has(t.sessionId)) });
  for (const target of targets) {
    if (!listedIds.has(target.sessionId)) throw new Error(`target ${target.sessionId} not visible in session/list`);
    const found = listed.find((entry) => entry.sessionId === target.sessionId);
    if (String(found?.cwd).toLowerCase() !== target.cwd.toLowerCase()) {
      throw new Error(`target ${target.sessionId} cwd mismatch: ${String(found?.cwd)}`);
    }
  }

  for (const target of targets) {
    const result: Record<string, unknown> = {
      kind: target.kind,
      sessionId: target.sessionId,
      cwd: target.cwd,
      persistedFileMtime: sessionFileMtime(target.sessionId),
    };

    // 2) Resume with an explicit release acknowledgement.
    const resumed = await callTool('dsh_resume_session', {
      session_id: target.sessionId,
      cwd: target.cwd,
      acknowledge_released: true,
    });
    result.resume = { ok: resumed.ok, note: resumed.note, error: resumed.error ?? null };
    record(`2. resume (${target.kind})`, result.resume);
    if (resumed.ok !== true) throw new Error(`resume failed for ${target.kind}: ${JSON.stringify(resumed)}`);

    // 3) Send one inert prompt and collect the reply.
    const started = Date.now();
    const sent = await callTool('dsh_send_message', { session_id: target.sessionId, text: target.prompt });
    result.send = {
      ok: sent.ok,
      stop_reason: sent.stop_reason,
      assistant_text: sent.assistant_text,
      assistant_text_truncated: sent.assistant_text_truncated,
      tool_calls: sent.tool_calls,
      usage: sent.usage,
      permission_events: sent.permission_events,
      wall_ms: Date.now() - started,
      error: sent.error ?? null,
    };
    record(`3. send_message (${target.kind})`, { reply: sent.assistant_text, stop_reason: sent.stop_reason, wall_ms: result.send.wall_ms });
    if (sent.ok !== true) throw new Error(`send failed for ${target.kind}: ${JSON.stringify(sent)}`);

    // Deliberately NO dsh_close_session: sessions stay persisted as instructed.
    (evidence.results as unknown[]).push(result);
  }

  evidence.ok = true;
}

void main()
  .catch((error: unknown) => {
    evidence.ok = false;
    evidence.error = error instanceof Error ? error.message : String(error);
    console.error('[sess] FAILED:', evidence.error);
  })
  .finally(async () => {
    bridge.stdin!.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        bridge.kill('SIGKILL');
        resolve();
      }, 20_000);
      bridge.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    reader.close();
    evidence.finishedAt = new Date().toISOString();
    evidence.note = 'dsh_close_session was NOT called; sessions remain persisted. Connection teardown only released the run scope.';
    mkdirSync(REPORTS_DIR, { recursive: true });
    const outPath = join(REPORTS_DIR, 'acceptance-desktop-sessions.json');
    writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    console.log(`[sess] evidence written to ${outPath}`);
    process.exit(evidence.ok === true ? 0 : 1);
  });
