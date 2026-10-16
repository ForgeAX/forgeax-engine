import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const dataRoot = resolve(process.argv[2] ?? 'artifacts/ray-sponza');
const server = await createServer({
  configFile: false,
  optimizeDeps: { entries: ['index.html'] },
  root: resolve(root, 'scripts/raytracing/gltf'),
  server: {
    hmr: false,
    watch: null,
    host: '127.0.0.1',
    port: 5197,
    strictPort: true,
    fs: { allow: [root] },
  },
  plugins: [
    {
      name: 'gltf-prepared',
      configureServer(server) {
        server.middlewares.use('/data', async (req, res) => {
          const name = (req.url ?? '').slice(1);
          if (!/^(prepared\.json|(?:triangles|nodes|attributes|image-\d+)\.bin)$/.test(name)) {
            res.statusCode = 404;
            res.end();
            return;
          }
          try {
            res.setHeader(
              'Content-Type',
              name.endsWith('.json') ? 'application/json' : 'application/octet-stream',
            );
            res.end(await readFile(resolve(dataRoot, name)));
          } catch {
            res.statusCode = 404;
            res.end();
          }
        });
      },
    },
  ],
});
await server.listen();
server.printUrls();
