import { randomBytes } from 'node:crypto';
import { connect as netConnect, type Socket } from 'node:net';

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export type DecodedFrame = { opcode: number; data: Buffer };

// Reassembles fragmented server frames. Chrome's screenshot replies are one
// large text frame, but the socket still delivers them in arbitrary chunks.
export class FrameParser {
  private buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private pending: Buffer[] = [];
  private pendingOpcode = 0;

  push(chunk: Buffer): DecodedFrame[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: DecodedFrame[] = [];
    while (this.buf.length >= 2) {
      const b0 = this.buf[0] ?? 0;
      const b1 = this.buf[1] ?? 0;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      if ((b1 & 0x80) !== 0) throw new Error('Chrome sent a masked WebSocket frame');
      let length = b1 & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buf.length < 4) return out;
        length = this.buf.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buf.length < 10) return out;
        const hi = this.buf.readUInt32BE(2);
        const lo = this.buf.readUInt32BE(6);
        if (hi !== 0) throw new Error('WebSocket frame is too large');
        length = lo;
        offset = 10;
      }
      if (this.buf.length < offset + length) return out;
      const payload = Buffer.from(this.buf.subarray(offset, offset + length));
      this.buf = this.buf.subarray(offset + length);
      if (opcode === OP_TEXT || opcode === OP_BINARY) {
        if (!fin) {
          this.pending = [payload];
          this.pendingOpcode = opcode;
          continue;
        }
        out.push({ opcode, data: payload });
        continue;
      }
      if (opcode === OP_CONTINUATION) {
        this.pending.push(payload);
        if (fin) {
          out.push({ opcode: this.pendingOpcode, data: Buffer.concat(this.pending) });
          this.pending = [];
        }
        continue;
      }
      out.push({ opcode, data: payload });
    }
    return out;
  }
}

export function encodeClientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | payload.length;
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(payload.length, 6);
  }
  return Buffer.concat([header, mask, masked]);
}

type TextHandler = (text: string) => void;
type CloseHandler = () => void;

export type WebSocketClient = {
  send(text: string): void;
  close(): void;
  onText(handler: TextHandler): void;
  onClose(handler: CloseHandler): void;
};

export function connectWebSocket(wsUrl: string): Promise<WebSocketClient> {
  const url = new URL(wsUrl);
  if (url.protocol !== 'ws:') {
    return Promise.reject(new Error(`Unsupported debugging URL: ${wsUrl}`));
  }
  const key = randomBytes(16).toString('base64');
  const request =
    `GET ${url.pathname}${url.search} HTTP/1.1\r\n` +
    `Host: ${url.host}\r\n` +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Key: ${key}\r\n` +
    'Sec-WebSocket-Version: 13\r\n\r\n';

  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: url.hostname, port: Number(url.port || 80) });
    socket.setNoDelay(true);
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.on('error', fail);
    let handshake = Buffer.alloc(0);
    const onHandshake = (chunk: Buffer) => {
      handshake = Buffer.concat([handshake, chunk]);
      const end = handshake.indexOf('\r\n\r\n');
      if (end === -1) return;
      const header = handshake.subarray(0, end).toString('utf8');
      if (!header.startsWith('HTTP/1.1 101')) {
        fail(new Error(`WebSocket upgrade failed: ${header.split('\r\n')[0]}`));
        return;
      }
      settled = true;
      socket.off('data', onHandshake);
      resolve(wrapSocket(socket, handshake.subarray(end + 4)));
    };
    socket.on('data', onHandshake);
    socket.write(request);
  });
}

function wrapSocket(socket: Socket, initial: Buffer): WebSocketClient {
  const parser = new FrameParser();
  let onText: TextHandler = () => {};
  let onClose: CloseHandler = () => {};
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    onClose();
  };
  const consume = (frames: DecodedFrame[]) => {
    for (const frame of frames) {
      if (frame.opcode === OP_TEXT) onText(frame.data.toString('utf8'));
      else if (frame.opcode === OP_PING) socket.write(encodeClientFrame(OP_PONG, frame.data));
      else if (frame.opcode === OP_CLOSE) {
        socket.end();
        finish();
      }
    }
  };
  if (initial.length > 0) consume(parser.push(initial));
  socket.on('data', (chunk: Buffer) => consume(parser.push(chunk)));
  socket.on('close', finish);
  socket.on('error', finish);
  return {
    send(text) {
      socket.write(encodeClientFrame(OP_TEXT, Buffer.from(text)));
    },
    close() {
      if (closed) return;
      try {
        socket.write(encodeClientFrame(OP_CLOSE, Buffer.alloc(0)));
      } catch {}
      socket.end();
    },
    onText(handler) {
      onText = handler;
    },
    onClose(handler) {
      onClose = handler;
    },
  };
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type CdpMessage = {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
};

export class CdpConnection {
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Set<(params: unknown) => void>>();

  constructor(private ws: WebSocketClient) {
    ws.onText((text) => {
      let message: CdpMessage;
      try {
        message = JSON.parse(text) as CdpMessage;
      } catch {
        return;
      }
      if (message.id != null) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message ?? 'CDP error'));
        else pending.resolve(message.result);
        return;
      }
      if (!message.method) return;
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
    });
    ws.onClose(() => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Chrome closed the debugging connection'));
      }
      this.pending.clear();
    });
  }

  on(method: string, listener: (params: unknown) => void): () => void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  send(
    method: string,
    params: object = {},
    sessionId?: string,
    timeoutMs = 30_000,
  ): Promise<unknown> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const message = sessionId ? { id, method, params, sessionId } : { id, method, params };
      this.ws.send(JSON.stringify(message));
    });
  }

  close(): void {
    this.ws.close();
  }
}
