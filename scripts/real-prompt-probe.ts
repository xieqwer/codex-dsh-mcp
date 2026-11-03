#!/usr/bin/env node
/**
 * Controlled real-model prompt probe (SPENDS TOKENS — opt-in only).
 *
 * Verifies the one link that fake tests cannot: a real DSH model turn through
 * `session/prompt`, including assistant reply collection, tool/permission
 * round-trip shape, stop reason and usage.
 *
 * Safety:
 *   - runs against a throw-away DSH_HOME and workspace under .tmp-tests/
 *   - never resumes or writes the user's real sessions
 *   - refuses to run without --confirm-cost
 *   - sends exactly one short prompt (default: "Reply with the single word: PONG")
 *
 * Usage:
 *   node scripts/real-prompt-probe.ts --confirm-cost [--prompt "…"] [--keep]
 *
 * Evidence: docs/reports/real-prompt-probe.json
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPORTS_DIR = join(PROJECT_ROOT, 'docs', 'reports');
const BRIDGE_ENTRY = join(PROJECT_ROOT, 'dist', 'index.js');

const args = process.argv.slice(2);
const confirmed = args.includes('--confirm-cost');
const keep = args.includes('--keep');
const promptIndex = args.indexOf('--prompt');
const promptText =
  promptIndex >= 0 && args[promptIndex + 1] !== undefined
    ? args[promptIndex + 1]
    : 'Reply with the single word: PONG';

if (!confirmed) {
  console.error(
    [
      'real-prompt-probe: refusing to run without explicit cost confirmation.',
      '',
      'This script sends ONE real prompt to a real DSH model and therefore spends',
      'tokens on your provider account. It uses a throw-away DSH_HOME under',
      '.tmp-tests/ and never touches your real sessions.',
      '',
      'Re-run with:',
      '  node scripts/real-prompt-probe.ts --confirm-cost',
      '',
      'Optional:',
      '  --prompt "your text"   override the probe prompt',
      '  --keep                 keep the temporary DSH_HOME for inspection',
    ].join('\n'),
  );
  process.exit(2);
}

const base = join(PROJECT_ROOT, '.tmp-tests');
mkdirSync(base, { recursive: true });
const dshHome = mkdtempSync(join(base, 'prompt-home-'));
const workspace = mkdtempSync(join(base, 'prompt-work-'));
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
  mode: 'real-model prompt (opt-in)',
  prompt: promptText,
  dshHome,
  workspace,
  steps: [] as unknown[],
};

function record(step: string, detail: unknown): void {
  (evidence.steps as unknown[]).push({ at: new Date().toISOString(), step, detail });
  console.log(`[prompt] ${step}`, JSON.stringify(detail));
}

const bridge = spawn(process.execPath, [BRIDGE_ENTRY], {
  cwd: PROJECT_ROOT,
  env: {
    ...process.env,
    DSH_CODEX_DSH_HOME: dshHome,
    DSH_CODEX_ALLOWED_CWDS: workspace,
    DSH_CODEX_LOG_FILE: join(workspace, 'bridge.log'),
    DSH_CODEX_LOG_LEVEL: 'info',
    DSH_CODEX_CONNECT_TIMEOUT_MS: '180000',
    DSH_CODEX_PROMPT_TIMEOUT_MS: String(Number(process.env.PROBE_PROMPT_TIMEOUT_MS ?? 180_000)),
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
    console.error('[prompt] non-JSON stdout:', line.slice(0, 200));
  }
});
bridge.stderr!.on('data', (chunk: Buffer) => process.stderr.write(chunk));

let nextId = 1;
async function request(method: string, params: Record<string, unknown>, timeoutMs = 240_000): Promise<Frame> {
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

async function callTool(name: string, toolArgs: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await request('tools/call', { name, arguments: toolArgs });
  if (response.error !== undefined) throw new Error(`${name}: ${JSON.stringify(response.error)}`);
  const content = (response.result?.content ?? []) as Array<{ type: string; text: string }>;
  return JSON.parse(content.map((block) => block.text).join('')) as Record<string, unknown>;
}

async function main(): Promise<void> {
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  bridge.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);

  const created = await callTool('dsh_create_session', { cwd: workspace });
  record('dsh_create_session', created);
  if (created.ok !== true) throw new Error(`create failed: ${JSON.stringify(created)}`);
  const sessionId = String(created.sessionId);

  const startedAt = Date.now();
  const sent = await callTool('dsh_send_message', { session_id: sessionId, text: promptText });
  record('dsh_send_message', {
    ...sent,
    wall_ms: Date.now() - startedAt,
  });

  if (sent.ok !== true) throw new Error(`prompt failed: ${JSON.stringify(sent)}`);

  const closed = await callTool('dsh_close_session', { session_id: sessionId, confirm: true });
  record('dsh_close_session', closed);

  evidence.ok = true;
  evidence.modelReply = {
    stop_reason: sent.stop_reason,
    assistant_text: sent.assistant_text,
    assistant_text_truncated: sent.assistant_text_truncated,
    usage: sent.usage,
    tool_calls: sent.tool_calls,
    permission_events: sent.permission_events,
    thoughts_included: sent.thoughts_included,
    wall_ms: sent.wall_ms,
  };
}

void main()
  .catch((error: unknown) => {
    evidence.ok = false;
    evidence.error = error instanceof Error ? error.message : String(error);
    console.error('[prompt] FAILED:', evidence.error);
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
    mkdirSync(REPORTS_DIR, { recursive: true });
    const outPath = join(REPORTS_DIR, 'real-prompt-probe.json');
    writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    console.log(`[prompt] evidence written to ${outPath}`);
    if (keep) {
      console.log(`[prompt] kept DSH_HOME=${dshHome} workspace=${workspace}`);
    } else {
      try {
        rmSync(dshHome, { recursive: true, force: true, maxRetries: 3 });
        rmSync(workspace, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // best effort
      }
    }
    process.exit(evidence.ok === true ? 0 : 1);
  });
