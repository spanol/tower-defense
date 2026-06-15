/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** WebSocket URL of the multiplayer game server, set at build time. */
  readonly VITE_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
