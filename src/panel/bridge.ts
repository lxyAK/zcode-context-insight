/**
 * MCP Apps 面板桥（协议层）：
 * JSON-RPC 2.0 over window.parent.postMessage（对照研究笔记 02 §2-§3 从 pdf 面板逆向还原）。
 * 面板侧一切宿主交互（ui/initialize 握手、callServerTool=tools/call 等）都走这里。
 */

/** postMessage 目标（测试时注入 mock） */
export interface PostTarget {
  postMessage(message: unknown, targetOrigin?: string): void;
}

/** JSON-RPC 2.0 消息（面板所需子集） */
export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** 极简合法性校验：非 JSON-RPC 消息直接丢弃（对照官方 transport 行为） */
function isJsonRpcMessage(data: unknown): data is JsonRpcMessage {
  if (typeof data !== "object" || data === null) return false;
  const msg = data as Record<string, unknown>;
  if (msg.jsonrpc !== "2.0") return false;
  return typeof msg.method === "string" || "id" in msg;
}

/** postMessage 传输 */
export class PostMessageTransport {
  private listener: ((ev: MessageEvent) => void) | null = null;
  onmessage: ((msg: JsonRpcMessage) => void) | null = null;

  constructor(
    private readonly win: Window,
    private readonly target: PostTarget,
  ) {}

  start(): void {
    this.listener = (ev: MessageEvent) => {
      if (!isJsonRpcMessage(ev.data)) return;
      this.onmessage?.(ev.data);
    };
    this.win.addEventListener("message", this.listener);
  }

  send(msg: JsonRpcMessage): void {
    this.target.postMessage(msg, "*");
  }

  close(): void {
    if (this.listener) this.win.removeEventListener("message", this.listener);
    this.listener = null;
  }
}

/** JSON-RPC 2.0 客户端：request/notify 封装 */
export class BridgeClient {
  private nextId = 1;
  private readonly pending = new Map<
    number | string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  constructor(private readonly transport: PostMessageTransport) {
    transport.onmessage = (msg) => this.handle(msg);
  }

  start(): void {
    this.transport.start();
  }

  private handle(msg: JsonRpcMessage): void {
    if (msg.id === undefined || !this.pending.has(msg.id)) return; // 通知/无关响应忽略
    const entry = this.pending.get(msg.id)!;
    this.pending.delete(msg.id);
    if (msg.error) {
      const err = new Error(msg.error.message);
      (err as Error & { code?: number }).code = msg.error.code;
      entry.reject(err);
    } else {
      entry.resolve(msg.result);
    }
  }

  request(method: string, params: unknown, timeoutMs = 10000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`面板桥请求超时: ${method}`));
        }
      }, timeoutMs).unref?.();
      this.transport.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.transport.send({ jsonrpc: "2.0", method, params });
  }
}
