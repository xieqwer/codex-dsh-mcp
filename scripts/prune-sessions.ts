#!/usr/bin/env node
/**
 * Prune DSH session directories that the desktop UI cannot see.
 *
 * ACP-created sessions are persisted as bare-UUID directories under
 * <DSH_HOME>/sessions/<group>/<id>. Because they are not registered in
 * <DSH_HOME>/storages/workspace.json, the desktop UI never lists them. The ACP
 * profile has no session/delete method, so they accumulate.
 *
 * This script deletes ONLY unregistered bare-UUID session directories:
 *   - dry-run by default (pass --yes to actually delete)
 *   - never touches `session-*` directories (desktop sessions)
 *   - never touches directories referenced by workspace.json
 *   - never reads or parses session content (only directory names are listed)
 *
 * Usage:
 *   node scripts/prune-sessions.ts [--home <DSH_HOME>] [--yes] [--json]
 *
 * Exit codes: 0 = ok (including dry-run with candidates), 1 = error.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

interface Args {
  home: string;
  yes: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  let home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  let yes = false;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--home') {
      const value = argv[++i];
      if (value === undefined || value.trim() === '') throw new Error('--home needs a directory');
      home = value;
    } else if (arg === '--yes') {
      yes = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/prune-sessions.ts [--home <DSH_HOME>] [--yes] [--json]');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { home: resolve(home), yes, json };
}

const BARE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Collect every session id referenced anywhere in workspace.json (read-only). */
function registeredIds(home: string): Set<string> {
  const file = join(home, 'storages', 'workspace.json');
  if (!existsSync(file)) return new Set();
  const ids = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      if (BARE_UUID.test(value) || value.startsWith('session-')) ids.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value)) visit(item);
    }
  };
  try {
    visit(JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) {
    throw new Error(`cannot parse ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return ids;
}

interface Candidate {
  id: string;
  path: string;
}

function scan(home: string): { total: number; registered: number; desktop: number; candidates: Candidate[] } {
  const root = join(home, 'sessions');
  if (!existsSync(root)) throw new Error(`no sessions directory at ${root} (set --home or DSH_HOME)`);
  const registered = registeredIds(home);
  let total = 0;
  let registeredCount = 0;
  let desktop = 0;
  const candidates: Candidate[] = [];

  for (const group of readdirSync(root, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    const groupDir = join(root, group.name);
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      total += 1;
      const dir = join(groupDir, entry.name);
      if (registered.has(entry.name)) {
        registeredCount += 1;
        continue;
      }
      if (entry.name.startsWith('session-')) {
        desktop += 1;
        continue;
      }
      if (BARE_UUID.test(entry.name)) candidates.push({ id: entry.name, path: dir });
    }
  }
  return { total, registered: registeredCount, desktop, candidates };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const result = scan(args.home);
  const root = resolve(args.home, 'sessions');

  const report = {
    dshHome: args.home,
    sessionsRoot: root,
    totalDirectories: result.total,
    registeredInWorkspace: result.registered,
    desktopSessionsKept: result.desktop,
    unregisteredBareUuid: result.candidates.length,
    mode: args.yes ? 'delete' : 'dry-run',
  };

  if (args.json) {
    console.log(JSON.stringify({ ...report, ids: result.candidates.map((candidate) => candidate.id) }, null, 2));
  } else {
    console.log(`DSH_HOME: ${args.home}`);
    console.log(`sessions: ${result.total} directories; registered=${result.registered}; desktop kept=${result.desktop}`);
    console.log(`unregistered bare-UUID candidates: ${result.candidates.length}`);
    for (const candidate of result.candidates.slice(0, 20)) console.log(`  ${candidate.id}  (${candidate.path})`);
    if (result.candidates.length > 20) console.log(`  ... and ${result.candidates.length - 20} more`);
  }

  if (!args.yes) {
    if (result.candidates.length > 0 && !args.json) {
      console.log('dry-run: nothing deleted. Re-run with --yes to delete the listed directories.');
    }
    return;
  }

  let deleted = 0;
  for (const candidate of result.candidates) {
    // Defensive check: the directory must live directly under sessions/<group>/.
    const resolved = resolve(candidate.path);
    if (!resolved.startsWith(`${root}\\`) && !resolved.startsWith(`${root}/`)) {
      console.error(`skip (outside sessions root): ${candidate.path}`);
      continue;
    }
    try {
      rmSync(resolved, { recursive: true, force: true, maxRetries: 3 });
      deleted += 1;
    } catch (error) {
      console.error(`failed to delete ${candidate.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`deleted ${deleted} of ${result.candidates.length} candidate session directories.`);
}

try {
  main();
} catch (error) {
  console.error(`prune-sessions: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
