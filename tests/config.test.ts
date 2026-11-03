import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ConfigError,
  detectDshCommand,
  loadConfig,
  validateCwd,
  validateSelection,
} from '../src/config.ts';
import { makeConfig, makeTempDir, removeDir, TMP_ROOT } from './helpers.ts';

test('loadConfig defaults: profile acp, allowlist defaults to cwd, sane timeouts', () => {
  const config = loadConfig({});
  assert.equal(config.profile, 'acp');
  assert.deepEqual(config.allowedProfiles, ['acp']);
  assert.equal(config.dshArgs.length, 0);
  assert.equal(config.allowedCwds.length, 1);
  assert.equal(config.connectTimeoutMs, 120_000);
  assert.equal(config.promptTimeoutMs, 600_000);
  assert.equal(config.toolsListWaitMs, 5_000);
  assert.equal(config.includeThoughts, false);
});

test('thoughts stay private unless DSH_CODEX_INCLUDE_THOUGHTS is explicitly enabled', () => {
  assert.equal(loadConfig({}).includeThoughts, false);
  assert.equal(loadConfig({ DSH_CODEX_INCLUDE_THOUGHTS: '1' }).includeThoughts, true);
  assert.equal(loadConfig({ DSH_CODEX_INCLUDE_THOUGHTS: 'false' }).includeThoughts, false);
  assert.throws(() => loadConfig({ DSH_CODEX_INCLUDE_THOUGHTS: 'maybe' }), ConfigError);
});

test('loadConfig rejects a relative allowlist entry', () => {
  assert.throws(() => loadConfig({ DSH_CODEX_ALLOWED_CWDS: 'relative/path' }), ConfigError);
});

test('loadConfig rejects a profile that is not explicitly allowed', () => {
  assert.throws(
    () => loadConfig({ DSH_CODEX_PROFILE: 'web', DSH_CODEX_ALLOWED_PROFILES: 'acp' }),
    /is not in DSH_CODEX_ALLOWED_PROFILES/u,
  );
});

test('loadConfig parses DSH_CODEX_DSH_ARGS_JSON and rejects malformed input', () => {
  const config = loadConfig({ DSH_CODEX_DSH_ARGS_JSON: '["--x","y"]' });
  assert.deepEqual(config.dshArgs, ['--x', 'y']);
  assert.throws(() => loadConfig({ DSH_CODEX_DSH_ARGS_JSON: 'not-json' }), ConfigError);
  assert.throws(() => loadConfig({ DSH_CODEX_DSH_ARGS_JSON: '"string"' }), ConfigError);
});

test('detectDshCommand prefers the explicit override', () => {
  assert.equal(detectDshCommand({ DSH_CODEX_DSH_COMMAND: 'C:\\fake\\dsh.cmd' }), 'C:\\fake\\dsh.cmd');
  assert.equal(detectDshCommand({}), 'dsh');
});

test('validateCwd accepts an allowlisted root, subdirectory and canonicalises the path', () => {
  const root = makeTempDir('config-cwd');
  const nested = join(root, 'nested');
  mkdirSync(nested);
  try {
    const config = makeConfig({ allowedCwds: [root] });
    assert.equal(validateCwd(root, config).ok, true);
    const decision = validateCwd(nested, config);
    assert.equal(decision.ok, true);
    assert.equal(decision.cwd, nested);
  } finally {
    removeDir(root);
  }
});

test('validateCwd rejects relative, missing and out-of-allowlist directories', () => {
  const root = makeTempDir('config-cwd-deny');
  try {
    const config = makeConfig({ allowedCwds: [root] });
    assert.equal(validateCwd('relative/dir', config).ok, false);
    assert.match(validateCwd('relative/dir', config).reason ?? '', /absolute/u);
    assert.equal(validateCwd(join(root, 'missing'), config).ok, false);
    assert.match(validateCwd(join(root, 'missing'), config).reason ?? '', /does not exist/u);
    assert.equal(validateCwd(TMP_ROOT, config).ok, false);
    assert.match(validateCwd(TMP_ROOT, config).reason ?? '', /outside the allowed directories/u);
  } finally {
    removeDir(root);
  }
});

test('validateCwd refuses a link that escapes the allowlist', (t) => {
  const root = makeTempDir('config-link');
  const outside = makeTempDir('config-link-outside');
  try {
    writeFileSync(join(outside, 'marker.txt'), 'outside', 'utf8');
    const linkPath = join(root, 'escape');
    try {
      symlinkSync(outside, linkPath, 'junction');
    } catch {
      t.skip('this host cannot create junctions/symlinks for the escape test');
      return;
    }
    const config = makeConfig({ allowedCwds: [root] });
    const decision = validateCwd(linkPath, config);
    assert.equal(decision.ok, false, 'a junction pointing outside the allowlist must be rejected');
  } finally {
    removeDir(root);
    removeDir(outside);
  }
});

test('validateSelection only accepts explicitly allowlisted values', () => {
  assert.equal(validateSelection(undefined, [], 'model').ok, true);
  assert.equal(validateSelection('m1', [], 'model').ok, false);
  assert.match(validateSelection('m1', [], 'model').reason ?? '', /disabled/u);
  assert.equal(validateSelection('m1', ['m1'], 'model').ok, true);
  assert.equal(validateSelection('m2', ['m1'], 'model').ok, false);
  assert.match(validateSelection('m2', ['m1'], 'model').reason ?? '', /not allowed/u);
});
