#!/usr/bin/env node
/**
 * codex-dsh-mcp entry point.
 *
 * Direction: Codex (MCP client) 鈫?this stdio server 鈫?`dsh --profile acp`
 * (ACP JSON-RPC child). Nothing here registers tools inside DSH.
 */
import { loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { McpServer } from './mcp-server.ts';
import { SessionBridge } from './session-tools.ts';

const VERSION = '0.2.0';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    process.stderr.write(
      `codex-dsh-mcp configuration error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
    return;
  }

  const logger = createLogger(config.logLevel, config.logFile);
  logger.info(
    `codex-dsh-mcp ${VERSION} starting: command=${JSON.stringify(config.dshCommand)} profile=${config.profile} ` +
      `dsh_home=${JSON.stringify(config.dshHome ?? process.env.DSH_HOME ?? '(inherited)')} ` +
      `allowed_cwds=${JSON.stringify(config.allowedCwds)}`,
  );

  const bridge = new SessionBridge(config, logger);
  const server = new McpServer({
    input: process.stdin,
    output: process.stdout,
    bridge,
    logger,
    toolsListWaitMs: config.toolsListWaitMs,
  });

  let stopping = false;
  const shutdown = (reason: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info(`shutting down: ${reason}`);
    void server.stop();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  process.on('uncaughtException', (error) => {
    logger.error(`uncaught exception: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    logger.error(`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
    shutdown('unhandledRejection');
  });

  server.start();
  await server.whenClosed;
  // Let pending stdout writes drain, then exit explicitly: the stdin stream can
  // otherwise keep the event loop alive after a client disconnect on Windows.
  await new Promise<void>((resolve) => setImmediate(resolve));
  logger.info('codex-dsh-mcp stopped');
  process.exit(process.exitCode ?? 0);
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `codex-dsh-mcp fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
