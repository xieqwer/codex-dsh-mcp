/**
 * Shared test helpers. All artefacts live under the project's `.tmp-tests/`
 * directory so the user's real DSH_HOME and sessions are never touched.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '../src/acp-process.ts';
import type { BridgeConfig } from '../src/config.ts';

export const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const TMP_ROOT = join(PROJECT_ROOT, '.tmp-tests');
export const FAKE_SERVER = join(PROJECT_ROOT, 'tests', 'fake-acp-server.ts');

export function makeTempDir(prefix: string): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  return mkdtempSync(join(TMP_ROOT, `${prefix}-`));
}

export function removeDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export const silentLogger: Logger = {
  error: () => {},
  info: () => {},
  debug: () => {},
};

export function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    dshCommand: process.execPath,
    dshArgs: [FAKE_SERVER],
    profile: 'acp',
    allowedProfiles: ['acp'],
    dshHome: undefined,
    allowedCwds: [TMP_ROOT],
    allowedModels: [],
    allowedReasoningEfforts: [],
    connectTimeoutMs: 8_000,
    callTimeoutMs: 8_000,
    promptTimeoutMs: 8_000,
    closeTimeoutMs: 3_000,
    maxOutputChars: 10_000,
    logLevel: 'silent',
    logFile: undefined,
    toolsListWaitMs: 3_000,
    includeThoughts: false,
    ...overrides,
  };
}

export interface ParsedToolResult {
  ok?: boolean;
  error?: { code: string; message: string };
  [key: string]: unknown;
}

export function parseToolText(outcome: { content: Array<{ type: string; text: string }>; isError?: boolean }): ParsedToolResult {
  const text = outcome.content.map((block) => block.text).join('');
  return JSON.parse(text) as ParsedToolResult;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `predicate` is true or the deadline passes. */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}
