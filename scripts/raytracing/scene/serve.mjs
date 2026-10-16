import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const prepared = await readFile(
  resolve(process.argv[2] ?? 'artifacts/ray-gi-scene', 'prepared.json'),
);
const server = await createServer({
  configFile: false,
  root: resolve(root, 'scripts/raytracing/scene'),
  server: {
    hmr: false,
    watch: null,
    host: '127.0.0.1',
    port: 5196,
    strictPort: true,
    fs: { allow: [root] },
  },
  plugins: [
    {
      name: 'gi-prepared',
      configureServer(server) {
        server.middlewares.use('/gi-prepared.json', (_req, res) => {
          res.setHeader('Content-Type', 'application/json');
          res.end(prepared);
        });
      },
    },
  ],
});
await server.listen();
server.printUrls();
