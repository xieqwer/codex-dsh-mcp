/**
 * Configuration for the DSH ⇄ Codex MCP bridge.
 *
 * Everything is read from the environment so that the bridge can be started by
 * Codex as a plain stdio child process. No secret is ever read or echoed here.
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type LogLevel = 'silent' | 'error' | 'info' | 'debug';

export interface BridgeConfig {
  /** Executable used to start the DSH ACP profile. */
  readonly dshCommand: string;
  /** Arguments inserted before `--profile <name>`. */
  readonly dshArgs: readonly string[];
  /** DSH profile to boot; only profile names from `allowedProfiles` are accepted. */
  readonly profile: string;
  readonly allowedProfiles: readonly string[];
  /** DSH_HOME handed to the child process; undefined inherits the parent env. */
  readonly dshHome: string | undefined;
  /** Canonical absolute directories a session `cwd` may live in. */
  readonly allowedCwds: readonly string[];
  /** Model ids a caller may explicitly select (empty = selection disabled). */
  readonly allowedModels: readonly string[];
  /** Reasoning-effort ids a caller may explicitly select (empty = disabled). */
  readonly allowedReasoningEfforts: readonly string[];
  readonly connectTimeoutMs: number;
  readonly callTimeoutMs: number;
  readonly promptTimeoutMs: number;
  readonly closeTimeoutMs: number;
  readonly maxOutputChars: number;
  readonly logLevel: LogLevel;
  /** Optional file that receives the same diagnostic lines as stderr. */
  readonly logFile: string | undefined;
  /** How long `tools/list` may wait for the ACP handshake before answering conservatively. */
  readonly toolsListWaitMs: number;
  /** Opt-in: return DSH `agent_thought_chunk` content to the MCP client (default false). */
  readonly includeThoughts: boolean;
}

export class ConfigError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
  }
}

const DEFAULT_PROFILE = 'acp';

function readPositiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError('DSH_INVALID_CONFIG', `${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigError('DSH_INVALID_CONFIG', `${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function splitList(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(/[;\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseDshArgs(raw: string | undefined): string[] {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new ConfigError('DSH_INVALID_CONFIG', 'DSH_CODEX_DSH_ARGS_JSON must be a JSON array of strings');
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    throw new ConfigError('DSH_INVALID_CONFIG', 'DSH_CODEX_DSH_ARGS_JSON must be a JSON array of strings');
  }
  return parsed as string[];
}

function readBoolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new ConfigError('DSH_INVALID_CONFIG', `${name} must be a boolean (1/0/true/false/yes/no/on/off), got ${JSON.stringify(raw)}`);
}

function canonicalDirectory(path: string, label: string): string {
  if (!isAbsolute(path)) {
    throw new ConfigError('DSH_INVALID_CONFIG', `${label} must be an absolute path, got ${JSON.stringify(path)}`);
  }
  let real: string;
  try {
    real = realpathSync.native(path);
  } catch {
    throw new ConfigError('DSH_INVALID_CONFIG', `${label} does not exist: ${JSON.stringify(path)}`);
  }
  if (!statSync(real).isDirectory()) {
    throw new ConfigError('DSH_INVALID_CONFIG', `${label} is not a directory: ${JSON.stringify(path)}`);
  }
  return real;
}

/** Detect the desktop-installed dsh CLI, then fall back to `dsh` on PATH. */
export function detectDshCommand(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.DSH_CODEX_DSH_COMMAND?.trim();
  if (explicit !== undefined && explicit !== '') return explicit;

  if (process.platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (localAppData !== undefined && localAppData !== '') {
      const candidate = join(localAppData, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
      if (existsSync(candidate)) return candidate;
    }
  }
  return 'dsh';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const profile = (env.DSH_CODEX_PROFILE?.trim() || DEFAULT_PROFILE);
  const allowedProfiles = splitList(env.DSH_CODEX_ALLOWED_PROFILES);
  const effectiveAllowedProfiles = allowedProfiles.length > 0 ? allowedProfiles : [profile];
  if (!effectiveAllowedProfiles.includes(profile)) {
    throw new ConfigError(
      'DSH_INVALID_CONFIG',
      `DSH_CODEX_PROFILE=${JSON.stringify(profile)} is not in DSH_CODEX_ALLOWED_PROFILES (${effectiveAllowedProfiles.join(', ')})`,
    );
  }

  const rawCwds = splitList(env.DSH_CODEX_ALLOWED_CWDS);
  if (rawCwds.length === 0) {
    // Defaulting to the current working directory keeps the bridge useful when
    // Codex starts it per-project, without opening the whole filesystem.
    rawCwds.push(process.cwd());
  }
  const allowedCwds = rawCwds.map((entry) => canonicalDirectory(entry, 'DSH_CODEX_ALLOWED_CWDS entry'));

  const allowedModels = splitList(env.DSH_CODEX_ALLOWED_MODELS);
  const allowedReasoningEfforts = splitList(env.DSH_CODEX_ALLOWED_REASONING_EFFORTS);

  const dshHomeRaw = env.DSH_CODEX_DSH_HOME?.trim() || env.DSH_HOME?.trim() || '';
  let dshHome: string | undefined;
  if (dshHomeRaw !== '') {
    if (!isAbsolute(dshHomeRaw)) {
      throw new ConfigError('DSH_INVALID_CONFIG', `DSH_CODEX_DSH_HOME must be an absolute path, got ${JSON.stringify(dshHomeRaw)}`);
    }
    dshHome = resolve(dshHomeRaw);
  }

  const logLevelRaw = (env.DSH_CODEX_LOG_LEVEL?.trim() || 'error') as LogLevel;
  if (!['silent', 'error', 'info', 'debug'].includes(logLevelRaw)) {
    throw new ConfigError('DSH_INVALID_CONFIG', `DSH_CODEX_LOG_LEVEL must be silent|error|info|debug, got ${JSON.stringify(logLevelRaw)}`);
  }

  return {
    dshCommand: detectDshCommand(env),
    dshArgs: parseDshArgs(env.DSH_CODEX_DSH_ARGS_JSON),
    profile,
    allowedProfiles: effectiveAllowedProfiles,
    dshHome,
    allowedCwds,
    allowedModels,
    allowedReasoningEfforts,
    connectTimeoutMs: readPositiveInt(env, 'DSH_CODEX_CONNECT_TIMEOUT_MS', 120_000),
    callTimeoutMs: readPositiveInt(env, 'DSH_CODEX_CALL_TIMEOUT_MS', 120_000),
    promptTimeoutMs: readPositiveInt(env, 'DSH_CODEX_PROMPT_TIMEOUT_MS', 600_000),
    closeTimeoutMs: readPositiveInt(env, 'DSH_CODEX_CLOSE_TIMEOUT_MS', 20_000),
    maxOutputChars: readPositiveInt(env, 'DSH_CODEX_MAX_OUTPUT_CHARS', 20_000),
    logLevel: logLevelRaw,
    logFile: env.DSH_CODEX_LOG_FILE?.trim() || undefined,
    toolsListWaitMs: readPositiveInt(env, 'DSH_CODEX_TOOLS_LIST_WAIT_MS', 5_000),
    includeThoughts: readBoolean(env, 'DSH_CODEX_INCLUDE_THOUGHTS', false),
  };
}

/** Case-insensitive on Windows, exact elsewhere. */
function normalizeForCompare(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** True when `child` equals `parent` or lives underneath it. */
function isInside(parent: string, child: string): boolean {
  const rel = relative(normalizeForCompare(parent), normalizeForCompare(child));
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${sep}`);
}

/**
 * True when a session's reported cwd lives inside the configured allowlist.
 *
 * Used to filter `session/list` results when the caller did not pass a cwd:
 * without it, an unfiltered list would expose session ids and paths from every
 * directory DSH knows about, bypassing the directory allowlist.
 */
export function isWithinAllowedCwds(rawCwd: unknown, allowed: readonly string[]): boolean {
  if (typeof rawCwd !== 'string' || rawCwd.trim() === '' || !isAbsolute(rawCwd)) return false;
  let canonical: string;
  try {
    canonical = realpathSync.native(rawCwd);
  } catch {
    // The session directory may have been deleted; fall back to the lexical path.
    canonical = resolve(rawCwd);
  }
  return allowed.some((root) => isInside(root, canonical));
}

export interface CwdDecision {
  ok: boolean;
  /** Canonical absolute path when ok. */
  cwd?: string;
  reason?: string;
}

/**
 * Validate a caller-supplied `cwd` against the allowlist.
 *
 * The path is canonicalised with realpath first, so a symlink or junction that
 * points outside the allowlist cannot smuggle a session into another directory.
 */
export function validateCwd(rawCwd: unknown, config: BridgeConfig): CwdDecision {
  if (typeof rawCwd !== 'string' || rawCwd.trim() === '') {
    return { ok: false, reason: 'cwd is required and must be a non-empty absolute path' };
  }
  if (!isAbsolute(rawCwd)) {
    return { ok: false, reason: `cwd must be an absolute path: ${JSON.stringify(rawCwd)}` };
  }
  let canonical: string;
  try {
    canonical = realpathSync.native(rawCwd);
  } catch {
    return { ok: false, reason: `cwd does not exist: ${JSON.stringify(rawCwd)}` };
  }
  try {
    if (!statSync(canonical).isDirectory()) {
      return { ok: false, reason: `cwd is not a directory: ${JSON.stringify(rawCwd)}` };
    }
  } catch {
    return { ok: false, reason: `cwd is not accessible: ${JSON.stringify(rawCwd)}` };
  }
  if (!config.allowedCwds.some((root) => isInside(root, canonical))) {
    return {
      ok: false,
      reason: `cwd is outside the allowed directories: ${JSON.stringify(canonical)} (allowed: ${config.allowedCwds.join(', ')})`,
    };
  }
  return { ok: true, cwd: canonical };
}

/** Validate an optional allowlisted selection (model or reasoning effort). */
export function validateSelection(
  rawValue: unknown,
  allowed: readonly string[],
  label: string,
): { ok: boolean; value?: string; reason?: string } {
  if (rawValue === undefined || rawValue === null || rawValue === '') return { ok: true };
  if (typeof rawValue !== 'string') {
    return { ok: false, reason: `${label} must be a string` };
  }
  if (allowed.length === 0) {
    return {
      ok: false,
      reason: `${label} selection is disabled: set ${label === 'model' ? 'DSH_CODEX_ALLOWED_MODELS' : 'DSH_CODEX_ALLOWED_REASONING_EFFORTS'} to enable it`,
    };
  }
  if (!allowed.includes(rawValue)) {
    return { ok: false, reason: `${label} ${JSON.stringify(rawValue)} is not allowed (allowed: ${allowed.join(', ')})` };
  }
  return { ok: true, value: rawValue };
}

export function defaultDshHome(): string {
  return join(homedir(), '.dsh');
}

export { delimiter as pathListDelimiter };
