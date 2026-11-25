/// <reference types="vite/client" />

/** Version and build time, set by vite.config.ts. */
declare const __BUILD__: string;

interface ImportMetaEnv {
  /** Address of the game server, e.g. https://notawork-space.example.workers.dev. Empty in local dev. */
  readonly VITE_SERVER_URL?: string;
}
