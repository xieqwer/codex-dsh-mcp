#!/usr/bin/env node
/**
 * Dump the real MCP `tools/list` response (schemas included) to a report file.
 *
 * Drives the actual McpServer over in-memory stdio with a fake ACP peer, so the
 * captured catalog is exactly what Codex would receive. Evidence:
 * docs/reports/tools-catalog.json
 */
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '../src/mcp-server.ts';
import { SessionBridge } from '../src/session-tools.ts';
import { makeConfig, makeTempDir, removeDir, silentLogger } from '../tests/helpers.ts';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPORTS_DIR = join(PROJECT_ROOT, 'docs', 'reports');

const root = makeTempDir('catalog');
const bridge = new SessionBridge(makeConfig({ allowedCwds: [root] }), silentLogger);
const input = new PassThrough();
const output = new PassThrough();
const frames: Array<Record<string, unknown>> = [];
const reader = createInterface({ input: output, crlfDelay: Number.POSITIVE_INFINITY });
reader.on('line', (line) => {
  if (line.trim() !== '') frames.push(JSON.parse(line) as Record<string, unknown>);
});

const server = new McpServer({
  input,
  output,
  bridge,
  logger: silentLogger,
  toolsListWaitMs: 3_000,
  shutdownBridgeOnClose: true,
});
server.start();

function send(frame: Record<string, unknown>): void {
  input.write(`${JSON.stringify(frame)}\n`);
}

async function waitForId(id: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const found = frames.find((frame) => frame.id === id);
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no response for request ${id}`);
}

try {
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'catalog-dump', version: '0.0.0' } } });
  const initialize = await waitForId(1);
  send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const toolsList = await waitForId(2);

  const report = {
    generatedAt: new Date().toISOString(),
    method: 'MCP initialize + notifications/initialized + tools/list',
    initializeResponse: initialize.result,
    toolsListResponse: toolsList.result,
    toolCount: ((toolsList.result as Record<string, unknown>)?.tools as unknown[] | undefined)?.length ?? 0,
  };
  mkdirSync(REPORTS_DIR, { recursive: true });
  const outPath = join(REPORTS_DIR, 'tools-catalog.json');
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`[catalog] ${report.toolCount} tools written to ${outPath}`);
  for (const tool of (report.toolsListResponse as Record<string, unknown>).tools as Array<Record<string, unknown>>) {
    console.log(`  - ${String(tool.name)}: ${String(tool.description).slice(0, 80)}…`);
  }
} finally {
  input.end();
  await server.whenClosed;
  reader.close();
  removeDir(root);
}
