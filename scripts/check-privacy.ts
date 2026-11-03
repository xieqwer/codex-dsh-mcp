#!/usr/bin/env node
/**
 * Privacy guard for the public repository.
 *
 * Scans every tracked file with **BOM/UTF-16 aware decoding** and fails when it
 * finds personal paths, real DSH session ids, email addresses or credentials.
 *
 * Generic rules ship with the repository. Machine-specific words (local user
 * name, personal project folders) are loaded from `privacy-patterns.local.json`,
 * which is git-ignored, so this file never contains private values itself.
 *
 * Run: `npm run check:privacy` (also executed in CI before tests).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.tmp-tests']);
const LOCAL_PATTERNS = join(ROOT, 'privacy-patterns.local.json');

function decode(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le');
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return Buffer.from(buffer.subarray(2)).swap16().toString('utf16le');
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8');
  }
  return buffer.toString('utf8');
}

function trackedFiles(): string[] {
  try {
    const output = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'buffer' });
    return output
      .toString('utf8')
      .split('\u0000')
      .filter((entry) => entry !== '')
      .filter((entry) => !SKIP_DIRS.has(entry.split('/')[0] ?? ''));
  } catch {
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else found.push(relative(ROOT, full).split('\\').join('/'));
      }
    };
    walk(ROOT);
    return found;
  }
}

/** Generic patterns that are safe to publish. */
const RULES: Array<{ name: string; re: RegExp }> = [
  { name: 'home directory with a user name', re: /C:\\+Users\\+[A-Za-z0-9_.-]/u },
  { name: 'dsh session id', re: /(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu },
  { name: 'truncated session id', re: /(?:session-)?[0-9a-f]{8}-(?:…|\.\.\.)/u },
  { name: 'email address', re: /[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com|example\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u },
  { name: 'github token', re: /(?:ghp_|github_pat_)[A-Za-z0-9_]{10,}/u },
  { name: 'bearer token', re: /Bearer\s+[A-Za-z0-9._-]{20,}/u },
  { name: 'windows hostname', re: /DESKTOP-[A-Z0-9]{7}/u },
];

/** Machine-specific words come from a local, git-ignored file. */
function loadLocalPatterns(): Array<{ name: string; needle: string }> {
  if (!existsSync(LOCAL_PATTERNS)) return [];
  try {
    const parsed = JSON.parse(readFileSync(LOCAL_PATTERNS, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.patterns) ? parsed.patterns : [];
    return list
      .filter((entry: unknown): entry is string => typeof entry === 'string' && entry.trim() !== '')
      .map((needle: string) => ({ name: `local machine word #${needle.length}`, needle }));
  } catch {
    console.error('check-privacy: ignoring unreadable privacy-patterns.local.json');
    return [];
  }
}

const files = trackedFiles();
const violations: string[] = [];
const localPatterns = loadLocalPatterns();
const SELF = 'scripts/check-privacy.ts';

for (const rel of files) {
  if (rel === SELF) continue;
  const full = join(ROOT, rel);
  if (!existsSync(full) || !statSync(full).isFile()) continue;
  const text = decode(readFileSync(full));
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    let hit: string | undefined;
    for (const rule of RULES) {
      if (rule.re.test(line)) {
        hit = rule.name;
        break;
      }
    }
    if (hit === undefined) {
      for (const extra of localPatterns) {
        if (line.includes(extra.needle)) {
          hit = extra.name;
          break;
        }
      }
    }
    if (hit !== undefined) {
      violations.push(`${rel}:${i + 1}: ${hit}: ${line.trim().slice(0, 120)}`);
    }
  }
}

if (violations.length > 0) {
  console.error(`check-privacy: ${violations.length} violation(s)\n`);
  for (const violation of violations) console.error(`  ${violation}`);
  console.error('\nFix these before publishing, then run `npm run check:privacy` again.');
  process.exit(1);
}

console.log(
  `check-privacy: OK (${files.length} tracked files, BOM/UTF-16 aware, ${localPatterns.length} local pattern(s))`,
);
