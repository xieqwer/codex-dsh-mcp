#!/usr/bin/env node
/**
 * Real DSH ACP probe (no model call).
 *
 * Boots `dsh --profile acp` against a throw-away DSH_HOME and exercises the
 * ACP surface the bridge relies on: initialize, session/new, session/list,
 * session/close, session/resume. It never sends a prompt, so no model tokens
 * are spent and no real user session is touched.
 *
 * Usage:
 *   node scripts/real-acp-probe.ts [--dsh <path-to-dsh.cmd>] [--keep]
 *
 * Writes evidence to docs/reports/real-acp-probe.json and prints a summary.
 * Must run outside the DSH workspace sandbox (profile bootstrap needs junctions).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { AcpProcess } from '../src/acp-process.ts';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPORTS_DIR = join(PROJECT_ROOT, 'docs', 'reports');

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const dshIndex = args.indexOf('--dsh');
const dshCommand =
  dshIndex >= 0 && args[dshIndex + 1] !== undefined
    ? args[dshIndex + 1]
    : process.platform === 'win32'
      ? join(
          process.env.LOCALAPPDATA ?? '',
          'Programs',
          'DeepSeek Harness',
          'resources',
          'runtime',
          'cli',
          'bin',
          'dsh.cmd',
        )
      : 'dsh';

const base = join(PROJECT_ROOT, '.tmp-tests');
mkdirSync(base, { recursive: true });
const dshHome = mkdtempSync(join(base, 'real-home-'));
const workspace = mkdtempSync(join(base, 'real-work-'));
const evidence: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  dshCommand,
  dshHome,
  workspace,
  dshCommandExists: existsSync(dshCommand),
  steps: [] as unknown[],
};

interface RpcFrame {
  id?: number | string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
  method?: string;
}

function record(step: string, detail: unknown): void {
  (evidence.steps as unknown[]).push({ at: new Date().toISOString(), step, detail });
  console.log(`[probe] ${step}`, JSON.stringify(detail));
}

async function main(): Promise<void> {
  if (!existsSync(dshCommand)) throw new Error(`dsh launcher not found: ${dshCommand}`);

  const logger = {
    error: (message: string) => console.error(`[dsh stderr] ${message}`),
    info: () => {},
    debug: () => {},
  };

  const acp = new AcpProcess({
    command: dshCommand,
    args: ['--profile', 'acp'],
    env: { ...process.env, DSH_HOME: dshHome },
    cwd: PROJECT_ROOT,
    logger,
    onExit: (exit) => {
      evidence.processExit = exit;
      console.log('[probe] dsh acp exited:', JSON.stringify(exit));
    },
  });

  const frames: RpcFrame[] = [];
  let exited = false;
  const originalOnExit = acp;
  void originalOnExit;

  try {
    acp.start();
  } catch (error) {
    throw new Error(`cannot spawn dsh: ${error instanceof Error ? error.message : String(error)}`);
  }
  acp.child.on('exit', () => {
    exited = true;
  });

  const reader = createInterface({ input: acp.child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
  reader.on('line', (line) => {
    if (line.trim() === '') return;
    try {
      frames.push(JSON.parse(line) as RpcFrame);
    } catch {
      console.error('[probe] non-JSON stdout line:', line.slice(0, 200));
    }
  });

  let nextId = 1;
  const request = async (method: string, params: Record<string, unknown>, timeoutMs = 180_000): Promise<RpcFrame> => {
    const id = nextId++;
    acp.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = frames.find((frame) => frame.id === id);
      if (found !== undefined) {
        if (found.error !== undefined) throw new Error(`${method} failed: ${JSON.stringify(found.error)}`);
        return found;
      }
      if (exited) throw new Error(`${method} failed: dsh acp exited before responding`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`${method} timed out after ${timeoutMs}ms`);
  };

  try {
    const init = await request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { terminal: false },
      clientInfo: { name: 'codex-dsh-mcp-probe', version: '0.1.0' },
    });
    record('initialize', init.result);

    const newSession = await request('session/new', { cwd: workspace, mcpServers: [] });
    const sessionId = String(newSession.result?.sessionId);
    record('session/new', { sessionId, configOptions: newSession.result?.configOptions ?? null });

    const listActive = await request('session/list', { cwd: null, cursor: null });
    record('session/list (before close; the active session is excluded by design)', listActive.result);

    await request('session/close', { sessionId });
    record('session/close', { sessionId });

    const listAfterClose = await request('session/list', { cwd: workspace, cursor: null });
    record('session/list (after close)', listAfterClose.result);

    const resumed = await request('session/resume', { sessionId, cwd: workspace, mcpServers: [] });
    record('session/resume', resumed.result);

    await request('session/close', { sessionId });
    record('session/close (after resume)', { sessionId });

    evidence.ok = true;
  } catch (error) {
    evidence.ok = false;
    evidence.error = error instanceof Error ? error.message : String(error);
    console.error('[probe] FAILED:', evidence.error);
  } finally {
    await acp.close(20_000);
    reader.close();
    evidence.finishedAt = new Date().toISOString();
    mkdirSync(REPORTS_DIR, { recursive: true });
    const outPath = join(REPORTS_DIR, 'real-acp-probe.json');
    writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    console.log(`[probe] evidence written to ${outPath}`);
    if (!keep) {
      rmSync(dshHome, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    } else {
      console.log(`[probe] kept DSH_HOME=${dshHome} workspace=${workspace}`);
    }
    process.exitCode = evidence.ok === true ? 0 : 1;
    process.exit(process.exitCode);
  }
}

void main().catch((error: unknown) => {
  console.error('[probe] fatal:', error);
  process.exitCode = 1;
  process.exit(1);
});
