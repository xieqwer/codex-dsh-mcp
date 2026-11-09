/**
 * ACP (Agent Client Protocol) JSON-RPC 2.0 client over newline-delimited JSON.
 *
 * Deliberately small: the bridge only needs the standard ACP v1 surface that the
 * DSH ACP profile actually advertises. No generic proxy, no private methods.
 */
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export const ACP_PROTOCOL_VERSION = 1;

export interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export class AcpError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(error: JsonRpcErrorShape) {
    super(error.message);
    this.name = 'AcpError';
    this.code = error.code;
    this.data = error.data;
  }
}

export class AcpTimeoutError extends Error {
  readonly method: string;
  readonly timeoutMs: number;
  constructor(method: string, timeoutMs: number) {
    super(`ACP request timed out after ${timeoutMs}ms: ${method}`);
    this.name = 'AcpTimeoutError';
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

export class AcpClosedError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(`ACP connection is not available: ${detail}`);
    this.name = 'AcpClosedError';
    this.detail = detail;
  }
}

export interface AgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean } | null;
  mcpCapabilities?: { http?: boolean; sse?: boolean } | null;
  sessionCapabilities?: {
    list?: object | null;
    resume?: object | null;
    close?: object | null;
    delete?: object | null;
    fork?: object | null;
  } | null;
}

export interface InitializeResult {
  protocolVersion: number;
  agentInfo?: { name: string; version: string; title?: string | null } | null;
  agentCapabilities?: AgentCapabilities | null;
  authMethods?: unknown[];
}

export interface SessionUpdateNotification {
  sessionId: string;
  update: { sessionUpdate: string; [key: string]: unknown };
}

export interface PermissionRequest {
  sessionId: string;
  toolCall: { toolCallId: string; [key: string]: unknown };
  options: Array<{ optionId: string; name: string; kind: string }>;
}

/** Answer for one `session/request_permission` request. */
export type PermissionDecision =
  | { outcome: 'selected'; optionId: string }
  | { outcome: 'cancelled' };

export type NotificationHandler = (method: string, params: unknown) => void;
export type RequestHandler = (method: string, params: unknown) => Promise<unknown>;

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface AcpClientOptions {
  input: Readable;
  output: Writable;
  requestTimeoutMs: number;
  clientName?: string;
  clientVersion?: string;
  onNotification?: NotificationHandler;
  onRequest?: RequestHandler;
  onProtocolWarning?: (message: string) => void;
}

export class AcpClient {
  readonly #input: Readable;
  readonly #output: Writable;
  readonly #requestTimeoutMs: number;
  readonly #clientName: string;
  readonly #clientVersion: string;
  readonly #onNotification: NotificationHandler | undefined;
  readonly #onRequest: RequestHandler | undefined;
  readonly #onProtocolWarning: (message: string) => void;

  #nextId = 1;
  readonly #pending = new Map<number, PendingRequest>();
  #closed: string | undefined;
  #initialized = false;
  #capabilities: AgentCapabilities = {};
  #agentInfo: InitializeResult['agentInfo'];
  readonly #reader: ReturnType<typeof createInterface>;

  constructor(options: AcpClientOptions) {
    this.#input = options.input;
    this.#output = options.output;
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#clientName = options.clientName ?? 'codex-dsh-mcp';
    this.#clientVersion = options.clientVersion ?? '0.2.0';
    this.#onNotification = options.onNotification;
    this.#onRequest = options.onRequest;
    this.#onProtocolWarning = options.onProtocolWarning ?? (() => {});

    this.#reader = createInterface({ input: this.#input, crlfDelay: Number.POSITIVE_INFINITY });
    this.#reader.on('line', (line) => {
      if (line.trim() === '') return;
      this.#handleLine(line);
    });
    this.#input.on('close', () => {
      if (this.#closed === undefined) this.#closed = 'ACP stdout closed';
      this.#failAll(new AcpClosedError('ACP stdout closed'));
    });
    this.#input.on('error', (error: Error) => {
      if (this.#closed === undefined) this.#closed = `ACP stdout error: ${error.message}`;
      this.#failAll(new AcpClosedError(`ACP stdout error: ${error.message}`));
    });
  }

  get initialized(): boolean {
    return this.#initialized;
  }

  get capabilities(): AgentCapabilities {
    return this.#capabilities;
  }

  get agentInfo(): InitializeResult['agentInfo'] {
    return this.#agentInfo;
  }

  get closed(): boolean {
    return this.#closed !== undefined;
  }

  get supportsSessionList(): boolean {
    return this.#capabilities.sessionCapabilities?.list !== undefined && this.#capabilities.sessionCapabilities?.list !== null;
  }

  get supportsSessionResume(): boolean {
    return this.#capabilities.sessionCapabilities?.resume !== undefined && this.#capabilities.sessionCapabilities?.resume !== null;
  }

  get supportsSessionClose(): boolean {
    return this.#capabilities.sessionCapabilities?.close !== undefined && this.#capabilities.sessionCapabilities?.close !== null;
  }

  /** Mark the connection as gone (process exited) and fail every pending call. */
  markClosed(detail: string): void {
    this.#closed = detail;
    this.#failAll(new AcpClosedError(detail));
    this.#reader.close();
  }

  #failAll(error: Error): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      if (pending.signal !== undefined && pending.onAbort !== undefined) {
        pending.signal.removeEventListener('abort', pending.onAbort);
      }
      pending.reject(error);
      this.#pending.delete(id);
    }
  }

  #handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.#onProtocolWarning(`discarding non-JSON stdout line (${line.length} chars)`);
      return;
    }
    if (message === null || typeof message !== 'object') {
      this.#onProtocolWarning('discarding non-object JSON-RPC message');
      return;
    }
    const frame = message as Record<string, unknown>;
    if (typeof frame.method === 'string') {
      if (frame.id !== undefined && (typeof frame.id === 'number' || typeof frame.id === 'string')) {
        void this.#handleInboundRequest(frame.id, frame.method, frame.params);
      } else {
        this.#onNotification?.(frame.method, frame.params);
      }
      return;
    }
    if (frame.id !== undefined && (typeof frame.id === 'number' || typeof frame.id === 'string')) {
      this.#handleResponse(frame);
      return;
    }
    this.#onProtocolWarning('discarding JSON-RPC message without method or id');
  }

  #handleResponse(frame: Record<string, unknown>): void {
    const id = Number(frame.id);
    const pending = this.#pending.get(id);
    if (pending === undefined) {
      this.#onProtocolWarning(`discarding response for unknown request id ${String(frame.id)}`);
      return;
    }
    clearTimeout(pending.timer);
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener('abort', pending.onAbort);
    }
    this.#pending.delete(id);
    if (frame.error !== undefined && frame.error !== null) {
      const raw = frame.error as Record<string, unknown>;
      pending.reject(
        new AcpError({
          code: typeof raw.code === 'number' ? raw.code : -32603,
          message: typeof raw.message === 'string' ? raw.message : 'unknown ACP error',
          data: raw.data,
        }),
      );
      return;
    }
    pending.resolve(frame.result);
  }

  async #handleInboundRequest(id: number | string, method: string, params: unknown): Promise<void> {
    if (this.#onRequest === undefined) {
      this.#write({ jsonrpc: '2.0', id, error: { code: -32601, message: `no handler for ${method}` } });
      return;
    }
    try {
      const result = await this.#onRequest(method, params);
      this.#write({ jsonrpc: '2.0', id, result: result ?? {} });
    } catch (error) {
      const acpError = error instanceof AcpError ? error : undefined;
      this.#write({
        jsonrpc: '2.0',
        id,
        error: {
          code: acpError?.code ?? -32603,
          message: error instanceof Error ? error.message : 'internal error',
        },
      });
    }
  }

  #write(frame: unknown): void {
    if (this.#closed !== undefined) return;
    this.#output.write(`${JSON.stringify(frame)}\n`);
  }

  request(method: string, params: unknown, options: RequestOptions = {}): Promise<unknown> {
    if (this.#closed !== undefined) {
      return Promise.reject(new AcpClosedError(this.#closed));
    }
    if (options.signal?.aborted === true) {
      return Promise.reject(options.signal.reason instanceof Error ? options.signal.reason : new Error('aborted'));
    }
    const id = this.#nextId++;
    const timeoutMs = options.timeoutMs ?? this.#requestTimeoutMs;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        if (options.signal !== undefined && onAbort !== undefined) {
          options.signal.removeEventListener('abort', onAbort);
        }
        reject(new AcpTimeoutError(method, timeoutMs));
      }, timeoutMs);
      // Keep the bridge process alive while a prompt is in flight.
      timer.unref?.();
      const onAbort =
        options.signal === undefined
          ? undefined
          : () => {
              clearTimeout(timer);
              this.#pending.delete(id);
              reject(
                options.signal?.reason instanceof Error ? options.signal.reason : new AcpClosedError('request aborted'),
              );
            };
      if (options.signal !== undefined && onAbort !== undefined) {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
      this.#pending.set(id, { method, resolve, reject, timer, signal: options.signal, onAbort });
      this.#write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.#write({ jsonrpc: '2.0', method, params });
  }

  /**
   * Perform the ACP handshake.
   *
   * `timeoutMs` overrides the client-wide request timeout so a bridge can give
   * `initialize` the (usually longer) connect budget without a separate
   * Promise.race wrapper.
   */
  async initialize(options: { timeoutMs?: number } = {}): Promise<InitializeResult> {
    const handshakeTimeout = options.timeoutMs ?? this.#requestTimeoutMs;
    const result = (await this.request(
      'initialize',
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { terminal: false },
        clientInfo: { name: this.#clientName, version: this.#clientVersion },
      },
      { timeoutMs: handshakeTimeout },
    )) as InitializeResult;

    if (typeof result?.protocolVersion !== 'number') {
      throw new AcpError({ code: -32603, message: 'initialize response is missing a numeric protocolVersion' });
    }
    if (result.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new AcpError({
        code: -32603,
        message: `unsupported ACP protocol version ${result.protocolVersion}; this bridge speaks ACP v${ACP_PROTOCOL_VERSION}`,
      });
    }
    this.#capabilities = result.agentCapabilities ?? {};
    this.#agentInfo = result.agentInfo;
    this.#initialized = true;
    // DSH advertises `authMethods: []`; only authenticate when an agent actually
    // requires it, so the bridge never invents an auth exchange.
    const authMethods = Array.isArray(result.authMethods) ? result.authMethods : [];
    if (authMethods.length > 0) {
      const first = authMethods[0] as { id?: unknown };
      if (typeof first?.id === 'string') {
        await this.request('authenticate', { methodId: first.id }, { timeoutMs: handshakeTimeout });
      }
    }
    return result;
  }

  close(): void {
    if (this.#closed === undefined) this.#closed = 'client closed';
    this.#failAll(new AcpClosedError('client closed'));
    this.#reader.close();
  }
}
