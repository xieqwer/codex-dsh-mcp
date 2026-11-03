#!/usr/bin/env node
/**
 * Test runner: one child process per test file.
 *
 * Node's default multi-file isolation spawns a subprocess per file with piped
 * stdio; under a restricted sandbox that spawn can be denied. Running each file
 * with the "no isolation" flag keeps files isolated in their own process while
 * needing only one plain spawn per file.
 *
 * The flag name differs by Node version:
 *   Node >= 23  -> --test-isolation=none
 *   Node 22.8+  -> --experimental-test-isolation=none
 *   older       -> omit it (fall back to the default runner isolation)
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const testsDir = join(root, 'tests');
const only = process.argv.slice(2);

const [nodeMajorRaw, nodeMinorRaw] = process.versions.node.split('.');
const nodeMajor = Number(nodeMajorRaw);
const nodeMinor = Number(nodeMinorRaw ?? '0');
const isolationFlag =
  nodeMajor >= 23
    ? '--test-isolation=none'
    : nodeMajor === 22 && nodeMinor >= 8
      ? '--experimental-test-isolation=none'
      : null;

const files = readdirSync(testsDir)
  .filter((name) => name.endsWith('.test.ts'))
  .filter((name) => (only.length === 0 ? true : only.some((fragment) => name.includes(fragment))))
  .sort();

if (files.length === 0) {
  console.error('run-tests: no test files matched');
  process.exit(1);
}

console.log(
  `run-tests: node ${process.versions.node} (${isolationFlag ?? 'default isolation'})`,
);

let failed = 0;
for (const file of files) {
  console.log(`\n=== ${file} ===`);
  const args = ['--test', ...(isolationFlag === null ? [] : [isolationFlag]), join('tests', file)];
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, NODE_OPTIONS: '', NODE_TEST_CONTEXT: '' },
  });
  if (result.status !== 0) {
    failed += 1;
    console.error(`run-tests: ${file} FAILED (exit ${String(result.status)})`);
  }
}

console.log(`\nrun-tests: ${files.length - failed}/${files.length} test files passed`);
process.exit(failed === 0 ? 0 : 1);
