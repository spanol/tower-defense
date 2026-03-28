/**
 * Network client — manages WebSocket connection to the game server.
 * Handles JSON (lobby) and binary (game state) messages.
 */

import { decode } from "@msgpack/msgpack";
import type {
  ClientMessage,
  ServerMessage,
  ServerGameState,
  ServerGameDelta,
} from "@td/shared";

export type MessageHandler = (msg: ServerMessage | ServerGameState | ServerGameDelta) => void;

const DEFAULT_URL = "ws://localhost:3001";

export class NetworkClient {
  private ws: WebSocket | null = null;
  private url: string;
  private handler: MessageHandler | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _connected = false;
  private seq = 0;

  constructor(url?: string) {
    this.url = url ?? DEFAULT_URL;
  }

  get connected(): boolean {
    return this._connected;
  }

  nextSeq(): number {
    return ++this.seq;
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);
        this.ws.binaryType = "arraybuffer";

        this.ws.onopen = () => {
          this._connected = true;
          resolve();
        };

        this.ws.onmessage = (event: MessageEvent) => {
          if (!this.handler) return;

          if (event.data instanceof ArrayBuffer) {
            // Binary — msgpack encoded game state/delta
            try {
              const msg = decode(new Uint8Array(event.data)) as ServerGameState | ServerGameDelta;
              this.handler(msg);
            } catch (e) {
              console.error("Failed to decode binary message:", e);
            }
          } else {
            // JSON — lobby messages
            try {
              const msg = JSON.parse(event.data as string) as ServerMessage;
              this.handler(msg);
            } catch (e) {
              console.error("Failed to parse JSON message:", e);
            }
          }
        };

        this.ws.onclose = () => {
          this._connected = false;
          this.scheduleReconnect();
        };

        this.ws.onerror = () => {
          this._connected = false;
          reject(new Error("WebSocket connection failed"));
        };
      } catch (e) {
        reject(e);
      }
    });
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null; // prevent reconnect
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
  }

  send(msg: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => {
        // Will retry via onclose
      });
    }, 2000);
  }
}

/** Singleton network client */
export const net = new NetworkClient();
