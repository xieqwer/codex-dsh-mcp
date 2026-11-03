/**
 * Diagnostic logger. Never writes to stdout: stdout belongs to MCP frames.
 */
import { appendFileSync } from 'node:fs';
import type { Logger } from './acp-process.ts';
import type { LogLevel } from './config.ts';

const LEVEL_ORDER: Record<LogLevel, number> = { silent: 0, error: 1, info: 2, debug: 3 };

export function createLogger(level: LogLevel, logFile?: string): Logger {
  const threshold = LEVEL_ORDER[level];
  const fileEnabled = logFile !== undefined && logFile !== '';
  let fileBroken = false;

  const emit = (kind: 'ERROR' | 'INFO' | 'DEBUG', message: string): void => {
    const line = `${new Date().toISOString()} ${kind} ${message}`;
    process.stderr.write(`${line}\n`);
    if (!fileEnabled || fileBroken) return;
    try {
      appendFileSync(logFile!, `${line}\n`, 'utf8');
    } catch (error) {
      fileBroken = true;
      process.stderr.write(
        `${new Date().toISOString()} ERROR cannot append to DSH_CODEX_LOG_FILE=${String(logFile)}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  };

  return {
    error: (message: string) => {
      if (threshold >= LEVEL_ORDER.error) emit('ERROR', message);
    },
    info: (message: string) => {
      if (threshold >= LEVEL_ORDER.info) emit('INFO', message);
    },
    debug: (message: string) => {
      if (threshold >= LEVEL_ORDER.debug) emit('DEBUG', message);
    },
  };
}
