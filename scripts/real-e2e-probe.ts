#!/usr/bin/env node
/**
 * Real end-to-end probe: MCP stdio → bridge → real `dsh --profile acp`.
 *
 * Runs against a throw-away DSH_HOME and a throw-away workspace, and never sends
 * a prompt (so no model call, no tokens, no user session touched). It proves:
 *   - the bridge process starts and lists the six MCP tools,
 *   - dsh_create_session works against the real ACP profile,
 *   - dsh_close_session releases the session,
 *   - dsh_list_sessions then shows the persisted session,
 *   - dsh_resume_session restores it (continue-a-conversation without replay).
 *
 * Evidence: docs/reports/real-e2e-probe.json
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPORTS_DIR = join(PROJECT_ROOT, 'docs', 'reports');
const BRIDGE_ENTRY = join(PROJECT_ROOT, 'dist', 'index.js');

const keep = process.argv.includes('--keep');
const base = join(PROJECT_ROOT, '.tmp-tests');
mkdirSync(base, { recursive: true });
const dshHome = mkdtempSync(join(base, 'e2e-home-'));
const workspace = mkdtempSync(join(base, 'e2e-work-'));
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
  method?: string;
}

const evidence: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  bridgeEntry: BRIDGE_ENTRY,
  dshLauncher,
  dshHome,
  workspace,
  steps: [] as unknown[],
};

function record(step: string, detail: unknown): void {
  (evidence.steps as unknown[]).push({ at: new Date().toISOString(), step, detail });
  console.log(`[e2e] ${step}`, JSON.stringify(detail));
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
        DSH_CODEX_DSH_COMMAND: dshLauncher,
        DSH_CODEX_ALLOWED_CWDS: workspace,
        DSH_CODEX_DSH_HOME: dshHome,
        DSH_CODEX_LOG_FILE: join(workspace, 'bridge.log'),
        DSH_CODEX_LOG_LEVEL: 'info',
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
        console.error('[e2e] non-JSON bridge stdout:', line.slice(0, 200));
      }
    });
    this.proc.stderr!.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
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

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.request('tools/call', { name, arguments: args });
    if (response.error !== undefined) throw new Error(`${name}: JSON-RPC error ${JSON.stringify(response.error)}`);
    const content = (response.result?.content ?? []) as Array<{ type: string; text: string }>;
    const text = content.map((block) => block.text).join('');
    return JSON.parse(text) as Record<string, unknown>;
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
  let sessionId = '';
  const first = new Bridge();
  try {
    const init = await first.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'codex-e2e-probe', version: '0.0.0' },
    });
    record('mcp initialize', init.result?.protocolVersion);
    first.notify('notifications/initialized');

    const tools = await first.request('tools/list');
    const names = (tools.result?.tools as Array<Record<string, unknown>>).map((tool) => tool.name);
    record('tools/list', names);

    const created = await first.callTool('dsh_create_session', { cwd: workspace });
    record('dsh_create_session', created);
    if (created.ok !== true) throw new Error(`create_session failed: ${JSON.stringify(created)}`);
    sessionId = String(created.sessionId);

    const stillActive = await first.callTool('dsh_list_sessions', { cwd: workspace });
    record('dsh_list_sessions while active (session excluded by ACP design)', stillActive);

    const closed = await first.callTool('dsh_close_session', { session_id: sessionId, confirm: true });
    record('dsh_close_session', closed);

    const afterClose = await first.callTool('dsh_list_sessions', { cwd: workspace });
    const listed = (afterClose.sessions as Array<Record<string, unknown>>) ?? [];
    record('dsh_list_sessions after close', afterClose);
    if (!listed.some((entry) => entry.sessionId === sessionId)) {
      throw new Error('closed session did not appear in session/list');
    }
  } finally {
    await first.close();
  }

  record('bridge process 1 exited', { sessionId });

  // Second bridge process: the persisted session must be listable and resumable.
  const second = new Bridge();
  try {
    await second.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    second.notify('notifications/initialized');
    const listed = await second.callTool('dsh_list_sessions', { cwd: workspace });
    record('bridge 2 dsh_list_sessions', listed);
    const resumed = await second.callTool('dsh_resume_session', {
      session_id: sessionId,
      cwd: workspace,
      acknowledge_released: true,
    });
    record('bridge 2 dsh_resume_session', resumed);
    if (resumed.ok !== true) throw new Error(`resume failed: ${JSON.stringify(resumed)}`);
    const closed = await second.callTool('dsh_close_session', { session_id: sessionId, confirm: true });
    record('bridge 2 dsh_close_session', closed);
    evidence.ok = true;
  } finally {
    await second.close();
  }
}

void main()
  .catch((error: unknown) => {
    evidence.ok = false;
    evidence.error = error instanceof Error ? error.message : String(error);
    console.error('[e2e] FAILED:', evidence.error);
  })
  .finally(() => {
    evidence.finishedAt = new Date().toISOString();
    mkdirSync(REPORTS_DIR, { recursive: true });
    const outPath = join(REPORTS_DIR, 'real-e2e-probe.json');
    writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    console.log(`[e2e] evidence written to ${outPath}`);
    if (keep) {
      console.log(`[e2e] kept DSH_HOME=${dshHome} workspace=${workspace}`);
    } else {
      safeRemove(dshHome);
      safeRemove(workspace);
    }
    process.exit(evidence.ok === true ? 0 : 1);
  });

function safeRemove(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 3 });
  } catch (error) {
    console.error(`[e2e] could not remove ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
