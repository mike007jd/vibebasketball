import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true,
    // honour an assigned PORT so the harness can place the dev server; falls
    // back to the usual 5173 for plain `npm run dev`
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
    // Browser QA writes evidence into the project. Those PNGs and build output
    // are not app source; watching them made Vite reload the game halfway
    // through an action test.
    watch: { ignored: ['**/caps/**', '**/output/**', '**/dist/**'] },
  },
  build: {
    target: 'es2022',
  },
});
