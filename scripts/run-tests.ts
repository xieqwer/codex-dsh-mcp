#!/usr/bin/env node
/**
 * Test runner: one child process per test file.
 *
 * Node's default multi-file isolation spawns a subprocess per file with piped
 * stdio; under a restricted sandbox that spawn can be denied. Running each file
 * with `--test-isolation=none` from this runner keeps files isolated in their own
 * process while needing only one plain spawn per file.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const testsDir = join(root, 'tests');
const only = process.argv.slice(2);

const files = readdirSync(testsDir)
  .filter((name) => name.endsWith('.test.ts'))
  .filter((name) => (only.length === 0 ? true : only.some((fragment) => name.includes(fragment))))
  .sort();

if (files.length === 0) {
  console.error('run-tests: no test files matched');
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  console.log(`\n=== ${file} ===`);
  const result = spawnSync(process.execPath, ['--test', '--test-isolation=none', join('tests', file)], {
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
