/**
 * Child-process lifecycle for the DSH ACP profile.
 *
 * The bridge never speaks to DSH storage directly: it owns one child process
 * (`dsh --profile acp`) whose stdin/stdout carry ACP JSON-RPC frames and whose
 * stderr is diagnostic only.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface Logger {
  error(message: string): void;
  info(message: string): void;
  debug(message: string): void;
}

export interface AcpProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** True when the bridge itself asked the process to stop. */
  expected: boolean;
}

export interface AcpProcessOptions {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  logger: Logger;
  onExit?: (exit: AcpProcessExit) => void;
}

/** How long `cmd.exe` keeps running after the child closes its pipes. */
const MAX_STDERR_LINE = 4_000;

export class AcpProcess {
  readonly #options: AcpProcessOptions;
  #child: ChildProcessWithoutNullStreams | undefined;
  #exit: AcpProcessExit | undefined;
  #stopping = false;

  constructor(options: AcpProcessOptions) {
    this.#options = options;
  }

  get child(): ChildProcessWithoutNullStreams {
    if (this.#child === undefined) throw new Error('acp process is not running');
    return this.#child;
  }

  get alive(): boolean {
    return this.#child !== undefined && this.#exit === undefined;
  }

  get exitInfo(): AcpProcessExit | undefined {
    return this.#exit;
  }

  /**
   * Start the child.
   *
   * On Windows a `.cmd`/`.bat` entry (the desktop `dsh.cmd` launcher) must run
   * through `cmd.exe`; a plain executable is spawned directly.
   */
  start(): void {
    if (this.#child !== undefined) throw new Error('acp process already started');
    const { command, args, env, cwd } = this.#options;
    const isWindows = process.platform === 'win32';
    const needsShell = isWindows && /\.(cmd|bat)$/i.test(command);

    let executable = command;
    let argv: string[];
    let verbatim = false;
    if (needsShell) {
      // `cmd.exe` does not use CommandLineToArgvW quoting rules, so hand it a
      // verbatim command line instead of letting Node escape the arguments.
      // The canonical form is: cmd /d /s /c ""C:\path with space\x.cmd" args"
      executable = env.ComSpec?.trim() || 'cmd.exe';
      const inner = [`"${command}"`, ...args.map(quoteForCmd)].join(' ');
      argv = ['/d', '/s', '/c', `"${inner}"`];
      verbatim = true;
    } else {
      argv = [...args];
    }

    const child = spawn(executable, argv, {
      cwd,
      env: env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
    });
    this.#child = child;

    child.on('error', (error) => {
      this.#options.logger.error(`dsh acp process error: ${error.message}`);
      this.#settle({ code: null, signal: null, expected: this.#stopping });
    });

    child.on('exit', (code, signal) => {
      this.#options.logger.info(`dsh acp process exited (code=${String(code)}, signal=${String(signal)})`);
      this.#settle({ code, signal, expected: this.#stopping });
    });

    // stderr is diagnostic only and must never reach the MCP stdout channel.
    const stderrLines = createInterface({ input: child.stderr, crlfDelay: Number.POSITIVE_INFINITY });
    stderrLines.on('line', (line) => {
      const trimmed = line.trimEnd();
      if (trimmed === '') return;
      this.#options.logger.error(
        trimmed.length > MAX_STDERR_LINE ? `${trimmed.slice(0, MAX_STDERR_LINE)}… [truncated]` : trimmed,
      );
    });
  }

  #settle(exit: AcpProcessExit): void {
    if (this.#exit !== undefined) return;
    this.#exit = exit;
    this.#options.onExit?.(exit);
  }

  /**
   * Graceful shutdown: close stdin (the ACP launcher treats EOF as a bounded
   * successful shutdown request), then escalate to SIGTERM and SIGKILL.
   */
  async close(timeoutMs: number): Promise<AcpProcessExit> {
    this.#stopping = true;
    const child = this.#child;
    if (child === undefined) return this.#exit ?? { code: null, signal: null, expected: true };

    try {
      child.stdin.end();
    } catch {
      // stdin may already be gone; the kill path below still settles the child.
    }

    const deadline = Date.now() + timeoutMs;
    while (this.#exit === undefined && Date.now() < deadline) {
      await delay(25);
    }
    if (this.#exit === undefined) {
      this.#options.logger.info('dsh acp process did not exit after stdin EOF; sending SIGTERM');
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore: the process may already be gone
      }
      const killDeadline = Date.now() + Math.min(5_000, timeoutMs);
      while (this.#exit === undefined && Date.now() < killDeadline) {
        await delay(25);
      }
    }
    if (this.#exit === undefined) {
      this.#options.logger.error('dsh acp process ignored SIGTERM; sending SIGKILL');
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      const finalDeadline = Date.now() + 5_000;
      while (this.#exit === undefined && Date.now() < finalDeadline) {
        await delay(25);
      }
    }
    return this.#exit ?? { code: null, signal: null, expected: true };
  }
}

function quoteForCmd(value: string): string {
  if (value === '') return '""';
  if (!/[\s"&|<>^]/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
