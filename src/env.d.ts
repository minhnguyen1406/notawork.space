/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Address of the game server, e.g. https://notawork-space.example.workers.dev. Empty in local dev. */
  readonly VITE_SERVER_URL?: string;
}
