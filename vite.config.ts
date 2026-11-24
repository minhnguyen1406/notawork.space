import { defineConfig } from 'vite';

// Relative base so the build works under https://<user>.github.io/notawork.space/
// and under a custom domain without changes.
export default defineConfig({
  base: './',
  server: {
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
});
