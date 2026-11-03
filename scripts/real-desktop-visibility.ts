#!/usr/bin/env node
/**
 * Desktop-session visibility probe (READ ONLY).
 *
 * Answers one question: does the bridge, running against the user's real
 * DSH_HOME, see sessions that the desktop app created?
 *
 * It only calls the ACP `session/list` method. It never resumes, prompts or
 * closes any existing session, and it never reads session contents: the local
 * side reads directory entry NAMES under $DSH_HOME/sessions to build the set of
 * persisted session ids for comparison.
 *
 * Evidence: docs/reports/desktop-sessions-visibility.json
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPORTS_DIR = join(PROJECT_ROOT, 'docs', 'reports');
const BRIDGE_ENTRY = join(PROJECT_ROOT, 'dist', 'index.js');
const DSH_HOME = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
const SESSIONS_DIR = join(DSH_HOME, 'sessions');
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;

interface Frame {
  id?: number | string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
  method?: string;
}

const evidence: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  dshHome: DSH_HOME,
  sessionsDir: SESSIONS_DIR,
  readOnly: true,
  steps: [] as unknown[],
};

function record(step: string, detail: unknown): void {
  (evidence.steps as unknown[]).push({ at: new Date().toISOString(), step, detail });
  console.log(`[vis] ${step}`, JSON.stringify(detail));
}

/** Collect persisted session ids from directory entry names only (no file reads). */
function localSessionIds(): { ids: string[]; filesScanned: number } {
  const ids = new Set<string>();
  let filesScanned = 0;
  if (!existsSync(SESSIONS_DIR)) return { ids: [], filesScanned };
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      filesScanned += 1;
      for (const match of entry.name.matchAll(UUID_RE)) ids.add(match[0].toLowerCase());
      // Directory names also carry the session id, so inspect them too.
      for (const match of dir.matchAll(UUID_RE)) ids.add(match[0].toLowerCase());
    }
  };
  walk(SESSIONS_DIR, 0);
  return { ids: [...ids], filesScanned };
}

class Bridge {
  readonly frames: Frame[] = [];
  #nextId = 1;
  #exited = false;
  readonly proc;
  readonly #reader: ReturnType<typeof createInterface>;

  constructor() {
    this.proc = spawn(process.execPath, [BRIDGE_ENTRY], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        DSH_CODEX_DSH_HOME: DSH_HOME,
        DSH_CODEX_LOG_LEVEL: 'info',
        DSH_CODEX_LOG_FILE: join(PROJECT_ROOT, '.tmp-tests', 'desktop-visibility-bridge.log'),
        DSH_CODEX_CONNECT_TIMEOUT_MS: '180000',
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
        console.error('[vis] non-JSON stdout:', line.slice(0, 200));
      }
    });
    this.proc.stderr!.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    this.proc.on('exit', () => {
      this.#exited = true;
    });
  }

  async request(method: string, params: Record<string, unknown>, timeoutMs = 240_000): Promise<Frame> {
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

  async callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.request('tools/call', { name, arguments: args });
    if (response.error !== undefined) throw new Error(`${name}: ${JSON.stringify(response.error)}`);
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

async function main(): Promise<void> {
  const local = localSessionIds();
  record('local persisted session ids (directory-entry names only)', {
    count: local.ids.length,
    filesScanned: local.filesScanned,
    sample: local.ids.slice(0, 5),
  });

  const bridge = new Bridge();
  try {
    await bridge.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    bridge.proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);

    const visible: Array<Record<string, unknown>> = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const listed = await bridge.callTool('dsh_list_sessions', {
        limit: 100,
        ...(cursor === null ? {} : { cursor }),
      });
      if (listed.ok !== true) throw new Error(`list failed: ${JSON.stringify(listed)}`);
      for (const entry of (listed.sessions as Array<Record<string, unknown>>) ?? []) visible.push(entry);
      const next = listed.nextCursor;
      if (typeof next !== 'string' || next === '' || listed.hasMore !== true) break;
      cursor = next;
    }
    record('ACP session/list visible sessions', { count: visible.length, sample: visible.slice(0, 5) });

    const visibleIds = new Set(
      visible.map((entry) => String(entry.sessionId).toLowerCase().replace(/^session-/u, '')),
    );
    const localIds = new Set(local.ids);
    const intersection = [...localIds].filter((id) => visibleIds.has(id));
    const localOnly = [...localIds].filter((id) => !visibleIds.has(id));
    const visibleOnly = [...visibleIds].filter((id) => !localIds.has(id));
    const cwdCounts = new Map<string, number>();
    for (const entry of visible) {
      const cwd = String(entry.cwd ?? '?');
      cwdCounts.set(cwd, (cwdCounts.get(cwd) ?? 0) + 1);
    }
    // ACP excludes sessions active in *its own process*, not sessions a separate
    // desktop process is currently running. Detect that boundary explicitly.
    const currentSession = (process.env.DSH_SESSION_ID ?? '').toLowerCase().replace(/^session-/u, '');
    const activeElsewhereListed = currentSession !== '' && visibleIds.has(currentSession);

    evidence.result = {
      acpVisibleCount: visibleIds.size,
      localPersistedCount: localIds.size,
      overlapCount: intersection.length,
      /** Sessions persisted locally that ACP did not list (subagent / child / non-root). */
      notListedCount: localOnly.length,
      /** ACP listed ids the name scanner did not derive (naming differences). */
      visibleOnlyCount: visibleOnly.length,
      cwdDistribution: Object.fromEntries([...cwdCounts.entries()].sort((a, b) => b[1] - a[1])),
      overlapSample: intersection.slice(0, 5),
      notListedSample: localOnly.slice(0, 5),
      /** True when the session this probe itself runs inside is listed: proves ACP
       *  cannot see another process's active sessions and can list them. */
      activeElsewhereListed,
      currentSessionId: currentSession === '' ? null : `session-${currentSession}`,
    };
    record('overlap', evidence.result);
    evidence.ok = intersection.length > 0;
    if (!evidence.ok) {
      evidence.note =
        'No overlap found. This does not necessarily mean desktop sessions are invisible: directory naming may not expose ids, or all desktop sessions were active. Inspect the samples before concluding.';
    }
  } finally {
    await bridge.close();
  }
}

void main()
  .catch((error: unknown) => {
    evidence.ok = false;
    evidence.error = error instanceof Error ? error.message : String(error);
    console.error('[vis] FAILED:', evidence.error);
  })
  .finally(() => {
    evidence.finishedAt = new Date().toISOString();
    mkdirSync(REPORTS_DIR, { recursive: true });
    const outPath = join(REPORTS_DIR, 'desktop-sessions-visibility.json');
    writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    console.log(`[vis] evidence written to ${outPath}`);
    process.exit(evidence.ok === true ? 0 : 1);
  });
