import { stripTypeScriptTypes } from 'node:module';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Build `dist/*.js` from `src/*.ts` with Node's built-in type stripper.
 *
 * The bridge deliberately has zero dependencies, so this script replaces tsc:
 * it strips types and rewrites relative `.ts` specifiers to `.js`.
 */
const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const srcDir = join(root, 'src');
const distDir = join(root, 'dist');

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

let built = 0;
for (const name of readdirSync(srcDir)) {
  if (!name.endsWith('.ts')) continue;
  const sourcePath = join(srcDir, name);
  const targetPath = join(distDir, `${name.slice(0, -'.ts'.length)}.js`);
  const source = readFileSync(sourcePath, 'utf8');
  let output = stripTypeScriptTypes(source, { mode: 'strip' });
  output = output.replace(/(\bfrom\s+['"])(\.{1,2}\/[^'"]+?)\.ts(['"])/gu, '$1$2.js$3');
  output = output.replace(/(\bimport\s*\(\s*['"])(\.{1,2}\/[^'"]+?)\.ts(['"]\s*\))/gu, '$1$2.js$3');
  writeFileSync(targetPath, output, 'utf8');
  built += 1;
}

if (built === 0) {
  process.stderr.write('build: no TypeScript sources found in src/\n');
  process.exitCode = 1;
} else {
  process.stdout.write(`build: wrote ${built} module(s) to ${distDir}\n`);
}
