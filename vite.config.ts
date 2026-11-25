import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

// Relative base so the build works under https://<user>.github.io/notawork.space/
// and under a custom domain without changes.
const commit = (() => {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return 'dev';
  }
})();

export default defineConfig({
  base: './',
  // Shown in the room's info panel, so you can tell which version a browser is running.
  define: { __BUILD__: JSON.stringify(`${commit} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`) },
  server: {
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
});
