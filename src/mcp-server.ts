/**
 * Minimal MCP stdio server.
 *
 * stdout carries JSON-RPC frames only. Every diagnostic goes to stderr (and an
 * optional log file) so a protocol violation can never be caused by logging.
 */
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { Logger } from './acp-process.ts';
import type { SessionBridge } from './session-tools.ts';

/** MCP revisions this server can speak, newest first. */
const SUPPORTED_MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
const DEFAULT_MCP_VERSION = SUPPORTED_MCP_VERSIONS[0];

const SERVER_NAME = 'codex-dsh-mcp';
const SERVER_VERSION = '0.1.0';

const INSTRUCTIONS = [
  'This server controls DeepSeek Harness (DSH) sessions through the DSH ACP profile.',
  'Typical flow: dsh_list_sessions -> dsh_create_session or dsh_resume_session -> dsh_send_message -> dsh_close_session.',
  'Always pass an explicit session_id; the bridge never assumes "the most recent session".',
  'A resumed session continues the persisted conversation but does NOT replay prior transcript content.',
  'DSH tool permission requests are denied unless permission_policy="allow_once" is passed explicitly.',
  'DSH internal thoughts are not returned unless the bridge operator enabled DSH_CODEX_INCLUDE_THOUGHTS.',
].join('\n');

export interface McpServerOptions {
  input: Readable;
  output: Writable;
  bridge: SessionBridge;
  logger: Logger;
  /** How long tools/list may wait for the ACP handshake before answering conservatively. */
  toolsListWaitMs: number;
  /** Stop the owned SessionBridge together with this server (default true). */
  shutdownBridgeOnClose?: boolean;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export class McpServer {
  readonly #input: Readable;
  readonly #output: Writable;
  readonly #bridge: SessionBridge;
  readonly #logger: Logger;
  readonly #toolsListWaitMs: number;
  readonly #shutdownBridgeOnClose: boolean;
  readonly #reader: ReturnType<typeof createInterface>;

  #closed = false;
  #initialized = false;
  #backgroundConnect: Promise<void> | undefined;
  #listChangedSent = false;
  #shutdownResolve: (() => void) | undefined;
  readonly #shutdownPromise: Promise<void>;

  constructor(options: McpServerOptions) {
    this.#input = options.input;
    this.#output = options.output;
    this.#bridge = options.bridge;
    this.#logger = options.logger;
    this.#toolsListWaitMs = options.toolsListWaitMs;
    this.#shutdownBridgeOnClose = options.shutdownBridgeOnClose ?? true;
    this.#reader = createInterface({ input: this.#input, crlfDelay: Number.POSITIVE_INFINITY });
    this.#reader.on('line', (line) => {
      if (this.#closed || line.trim() === '') return;
      void this.#handleLine(line);
    });
    this.#shutdownPromise = new Promise<void>((resolve) => {
      this.#shutdownResolve = resolve;
    });
    this.#input.on('close', () => {
      this.#logger.info('mcp stdin closed; shutting down');
      void this.stop();
    });
    this.#input.on('error', (error: Error) => {
      this.#logger.error(`mcp stdin error: ${error.message}`);
      void this.stop();
    });
  }

  get whenClosed(): Promise<void> {
    return this.#shutdownPromise;
  }

  /** Start talking. The ACP child is connected lazily, never during MCP initialize. */
  start(): void {
    this.#logger.info(`mcp server ready (name=${SERVER_NAME} version=${SERVER_VERSION})`);
    void this.#backgroundConnectToAcp();
  }

  async stop(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#reader.close();
    if (this.#shutdownBridgeOnClose) {
      try {
        await this.#bridge.shutdown();
      } catch (error) {
        this.#logger.error(`bridge shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.#shutdownResolve?.();
  }

  #backgroundConnectToAcp(): Promise<void> {
    if (this.#backgroundConnect !== undefined) return this.#backgroundConnect;
    this.#backgroundConnect = this.#bridge
      .ensureConnected()
      .then(() => {
        this.#logger.info('background ACP handshake succeeded');
        if (this.#initialized && !this.#listChangedSent) {
          this.#listChangedSent = true;
          this.#notify('notifications/tools/list_changed', {});
        }
      })
      .catch((error: unknown) => {
        this.#logger.info(
          `background ACP handshake failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        this.#backgroundConnect = undefined;
      });
    return this.#backgroundConnect;
  }

  async #handleLine(line: string): Promise<void> {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      this.#logger.error('discarding non-JSON stdin line');
      this.#write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }
    if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) {
      this.#write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } });
      return;
    }
    const message = frame as Record<string, unknown>;
    if (typeof message.method === 'string') {
      const hasId = typeof message.id === 'number' || typeof message.id === 'string';
      if (!hasId) {
        this.#handleNotification(message.method, message.params);
        return;
      }
      try {
        const result = await this.#handleRequest(message.method, message.params);
        this.#write({ jsonrpc: '2.0', id: message.id, result });
      } catch (error) {
        const method = message.method;
        const code = error instanceof JsonRpcError ? error.code : -32603;
        this.#logger.info(`mcp request ${method} failed: ${error instanceof Error ? error.message : String(error)}`);
        this.#write({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code,
            message: error instanceof Error ? error.message : 'internal error',
          },
        });
      }
      return;
    }
    // A response to a request this server never sends: ignore it.
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) return;
    this.#write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } });
  }

  #handleNotification(method: string, params: unknown): void {
    switch (method) {
      case 'notifications/initialized':
        this.#initialized = true;
        this.#logger.info('mcp client initialized');
        // If the ACP handshake already finished, tell the client the catalog may
        // now be capability-accurate instead of waiting for another tools/list.
        if (this.#bridge.connected && !this.#listChangedSent) {
          this.#listChangedSent = true;
          this.#notify('notifications/tools/list_changed', {});
        }
        return;
      case 'notifications/cancelled': {
        const record = (params ?? {}) as Record<string, unknown>;
        this.#logger.info(`mcp client cancelled request ${String(record.requestId)}: ${String(record.reason ?? '')}`);
        return;
      }
      case 'notifications/roots/list_changed':
        return;
      default:
        this.#logger.debug(`ignoring MCP notification ${method}`);
        return;
    }
  }

  async #handleRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return this.#initialize(params);
      case 'ping':
        return {};
      case 'tools/list':
        return this.#toolsList(params);
      case 'tools/call':
        return this.#toolsCall(params);
      default:
        throw new JsonRpcError(-32601, `method not found: ${method}`);
    }
  }

  #initialize(params: unknown): Record<string, unknown> {
    const record = (params ?? {}) as Record<string, unknown>;
    const requested = typeof record.protocolVersion === 'string' ? record.protocolVersion : '';
    const version = (SUPPORTED_MCP_VERSIONS as readonly string[]).includes(requested)
      ? requested
      : DEFAULT_MCP_VERSION;
    this.#logger.info(`mcp initialize: requested=${requested || '(missing)'} negotiated=${version}`);
    const clientInfo = (record.clientInfo ?? {}) as Record<string, unknown>;
    this.#logger.info(
      `mcp client: ${String(clientInfo.name ?? '?')} ${String(clientInfo.version ?? '?')} ` +
        `capabilities=${JSON.stringify(record.capabilities ?? {})}`,
    );
    return {
      protocolVersion: version,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: INSTRUCTIONS,
    };
  }

  async #toolsList(params: unknown): Promise<Record<string, unknown>> {
    const record = (params ?? {}) as Record<string, unknown>;
    if (record.cursor !== undefined && record.cursor !== null) {
      // One page only: the catalog is small and fixed.
      return { tools: [] };
    }
    // Give the ACP handshake a short head start so the first catalog can reflect
    // real negotiated capabilities, but never block past the MCP startup budget.
    await Promise.race([
      this.#backgroundConnectToAcp(),
      delay(this.#toolsListWaitMs),
    ]);
    const catalog = this.#bridge.catalog();
    if (catalog.notes.length > 0) this.#logger.info(`tools/list notes: ${catalog.notes.join(' | ')}`);
    return { tools: catalog.tools };
  }

  async #toolsCall(params: unknown): Promise<Record<string, unknown>> {
    const record = (params ?? {}) as Record<string, unknown>;
    const name = record.name;
    if (typeof name !== 'string' || name === '') {
      throw new JsonRpcError(-32602, 'tools/call requires a tool name');
    }
    const args = record.arguments;
    if (args !== undefined && args !== null && (typeof args !== 'object' || Array.isArray(args))) {
      throw new JsonRpcError(-32602, 'tools/call arguments must be an object');
    }
    const catalog = this.#bridge.catalog();
    if (!catalog.tools.some((entry) => entry.name === name)) {
      throw new JsonRpcError(-32602, `unknown tool: ${name} (available: ${catalog.tools.map((entry) => entry.name).join(', ')})`);
    }
    this.#logger.info(`mcp tools/call ${name}`);
    const outcome = await this.#bridge.call(name, (args ?? {}) as Record<string, unknown>);
    return outcome as unknown as Record<string, unknown>;
  }

  #notify(method: string, params: unknown): void {
    this.#write({ jsonrpc: '2.0', method, params });
  }

  #write(frame: Record<string, unknown>): void {
    if (this.#closed) return;
    this.#output.write(`${JSON.stringify(frame)}\n`);
  }
}

export class JsonRpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = 'JsonRpcError';
    this.code = code;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type { JsonRpcRequest };
