#!/usr/bin/env node
/**
 * Remove build output and test scratch space.
 */
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

for (const entry of ['dist', '.tmp-tests']) {
  rmSync(join(root, entry), { recursive: true, force: true });
  console.log(`clean: removed ${entry}/`);
}
