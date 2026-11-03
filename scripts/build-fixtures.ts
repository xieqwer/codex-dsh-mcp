import { stripTypeScriptTypes } from 'node:module';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Build the tests' fake ACP peer into `dist/tests/` so the bridge can spawn it
 * as a real child process using the same launcher shape as `dsh --profile acp`.
 */
const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const testsDir = join(root, 'tests');
const outDir = join(root, 'dist', 'tests');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

let built = 0;
for (const name of readdirSync(testsDir)) {
  if (!name.endsWith('.ts')) continue;
  const source = readFileSync(join(testsDir, name), 'utf8');
  let output = stripTypeScriptTypes(source, { mode: 'strip' });
  output = output.replace(/(\bfrom\s+['"])(\.{1,2}\/[^'"]+?)\.ts(['"])/gu, '$1$2.js$3');
  writeFileSync(join(outDir, `${name.slice(0, -'.ts'.length)}.js`), output, 'utf8');
  built += 1;
}
process.stdout.write(`build:fixtures wrote ${built} module(s) to ${outDir}\n`);
