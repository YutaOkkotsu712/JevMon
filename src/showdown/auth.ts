import type { ProtocolMessage } from './protocol.js';

export interface Credentials { username: string; password: string }
const userId = (name: string) => name.split('@')[0]!.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Official login response has a leading anti-JSON-hijacking `]`. */
export async function getAssertion(credentials: Credentials, challenge: string, signal: AbortSignal,
  request: typeof fetch = fetch): Promise<string> {
  try {
    const response = await request('https://play.pokemonshowdown.com/api/login', {
      method: 'POST', redirect: 'error', signal,
      body: new URLSearchParams({ name: credentials.username, pass: credentials.password, challstr: challenge }),
    });
    if (!response.ok) throw new Error();
    const text = await response.text();
    if (!text.startsWith(']')) throw new Error();
    const data: unknown = JSON.parse(text.slice(1));
    if (!data || typeof data !== 'object' || !('assertion' in data) ||
        typeof data.assertion !== 'string' || !data.assertion.trim() ||
        /^[;\n]/.test(data.assertion) || /[\r\n\0|]/.test(data.assertion) ||
        ('actionsuccess' in data && data.actionsuccess !== true)) throw new Error();
    return data.assertion;
  } catch {
    throw new Error('Showdown login failed; check credentials and service availability');
  }
}

interface AuthOptions {
  credentials: Credentials;
  send: (command: string) => boolean;
  onStatus: (status: string) => void;
  onAuthenticated: () => void;
  onFailure: () => void;
  request?: typeof fetch;
  timeoutMs?: number;
}

export class ShowdownAuth {
  private controller: AbortController | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private challenge: string | undefined;
  private awaitingConfirmation = false;
  private authenticated = false;
  constructor(private readonly options: AuthOptions) {}

  reset(): void {
    this.controller?.abort();
    this.controller = undefined;
    clearTimeout(this.timer);
    this.challenge = undefined;
    this.awaitingConfirmation = false;
    this.authenticated = false;
  }

  handle(message: ProtocolMessage): void {
    if (message.room !== null) return;
    if (message.type === 'challstr' && /^\d+\|.+$/.test(message.data)) {
      if (this.challenge === message.data) return;
      this.reset();
      this.challenge = message.data;
      const controller = new AbortController();
      this.controller = controller;
      this.timer = setTimeout(() => this.fail('authentication timed out'), this.options.timeoutMs ?? 15_000);
      this.options.onStatus('authenticating');
      void this.login(message.data, controller);
    } else if (message.type === 'nametaken' && this.awaitingConfirmation) {
      this.fail('server rejected login');
    } else if (message.type === 'updateuser' && this.awaitingConfirmation) {
      const [name = '', named] = message.data.split('|');
      if (named !== '1' || userId(name) !== userId(this.options.credentials.username)) return;
      clearTimeout(this.timer);
      this.awaitingConfirmation = false;
      this.authenticated = true;
      this.options.onStatus('authenticated');
      this.options.onAuthenticated();
    } else if (message.type === 'updateuser' && this.authenticated) {
      const [name = '', named] = message.data.split('|');
      if (named !== '1' || userId(name) !== userId(this.options.credentials.username)) {
        this.fail('authenticated identity lost');
      }
    }
  }

  private fail(status: string): void {
    this.reset();
    this.options.onStatus(status);
    this.options.onFailure();
  }

  private async login(challenge: string, controller: AbortController): Promise<void> {
    try {
      const assertion = await getAssertion(this.options.credentials, challenge, controller.signal, this.options.request);
      // An assertion belongs to one socket challenge; never replay it after reconnect.
      if (this.controller !== controller || controller.signal.aborted) return;
      this.awaitingConfirmation = true;
      if (!this.options.send(`|/trn ${this.options.credentials.username},0,${assertion}`)) {
        this.fail('login command could not be sent');
      }
    } catch {
      if (this.controller !== controller || controller.signal.aborted) return;
      this.fail('authentication failed; check credentials and service availability');
    }
  }
}
