import { parseFrame, type ProtocolMessage } from './protocol.js';

export interface ClientOptions {
  url: string;
  onMessage: (message: ProtocolMessage) => void;
  onStatus: (status: string) => void;
  onDisconnect?: () => void;
  socketFactory?: (url: string) => WebSocket;
  reconnectBaseMs?: number;
  handshakeTimeoutMs?: number;
}

/** Connection only. Authentication and battle commands belong in later components. */
export class ShowdownClient {
  private socket: WebSocket | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private handshake: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private attempts = 0;

  constructor(private readonly options: ClientOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempts = 0;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    clearTimeout(this.handshake);
    const socket = this.socket;
    this.socket = undefined;
    this.options.onDisconnect?.();
    socket?.close();
  }

  send(command: string): boolean {
    if (this.stopped || this.socket?.readyState !== WebSocket.OPEN) return false;
    if (!/^(?:battle-gen9randombattle-[a-z0-9-]+)?\|\//.test(command) || /[\r\n\0]/.test(command)) return false;
    try {
      this.socket.send(command);
      return true;
    } catch {
      this.options.onStatus('send failed');
      return false;
    }
  }

  private reconnect(): void {
    if (this.stopped) return;
    const delay = Math.min(30_000, (this.options.reconnectBaseMs ?? 1000) * 2 ** Math.min(this.attempts++, 5));
    this.options.onStatus(`reconnecting in ${delay}ms`);
    this.retry = setTimeout(() => this.connect(), delay);
  }

  private connect(): void {
    if (this.stopped) return;
    this.options.onStatus('connecting');
    let socket: WebSocket;
    try {
      socket = (this.options.socketFactory ?? ((url) => new WebSocket(url)))(this.options.url);
    } catch {
      this.options.onStatus('connection creation failed');
      this.reconnect();
      return;
    }
    this.socket = socket;
    const current = () => !this.stopped && this.socket === socket;
    const disconnect = () => {
      if (!current()) return;
      clearTimeout(this.handshake);
      this.socket = undefined;
      this.options.onDisconnect?.();
      socket.close();
      this.reconnect();
    };
    this.handshake = setTimeout(() => {
      if (!current()) return;
      this.options.onStatus('handshake timed out');
      disconnect();
    }, this.options.handshakeTimeoutMs ?? 15_000);
    socket.addEventListener('open', () => {
      if (current()) this.options.onStatus('websocket open');
    });
    socket.addEventListener('message', (event) => {
      if (!current()) return;
      if (typeof event.data !== 'string') {
        this.options.onStatus('ignored non-text frame');
        return;
      }
      for (const message of parseFrame(event.data)) {
        if (!current()) break;
        if (message.room === null && message.type === 'challstr' && /^\d+\|.+$/.test(message.data)) {
          clearTimeout(this.handshake);
          this.attempts = 0;
          this.options.onStatus('Showdown handshake received');
        }
        try {
          this.options.onMessage(message);
        } catch {
          // Do not log arbitrary errors: they can include protocol data or secrets.
          this.options.onStatus('message handler failed');
        }
      }
    });
    socket.addEventListener('error', () => {
      if (!current()) return;
      this.options.onStatus('websocket error');
      disconnect();
    });
    socket.addEventListener('close', () => {
      if (!current()) return;
      this.options.onStatus('websocket closed');
      disconnect();
    });
  }
}
