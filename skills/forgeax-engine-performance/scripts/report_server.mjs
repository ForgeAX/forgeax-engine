import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';

/** Loopback-only, fixed report assets; never expose the source checkout or arbitrary files. */
export async function serveReport(directory, { port = 0, entry, files } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Require port 0..65535');
  if (!files?.has(entry)) throw Error('Require a fixed report asset manifest');
  const root = await realpath(resolve(directory));
  if (!(await stat(join(root, entry))).isFile()) throw Error('Require a report directory');
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://' + request.headers.host);
      if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
        response.writeHead(403).end();
        return;
      }
      if (!['GET', 'HEAD'].includes(request.method)) {
        response.writeHead(405).end();
        return;
      }
      const file = url.pathname === '/' ? entry : decodeURIComponent(url.pathname.slice(1));
      if (!files.has(file)) {
        response.writeHead(404).end();
        return;
      }
      const path = await realpath(join(root, file));
      if (path !== join(root, file) || dirname(path) !== root || !(await stat(path)).isFile()) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        'Content-Type': files.get(file),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      if (request.method === 'HEAD') response.end();
      else
        createReadStream(path)
          .on('error', () => response.destroy())
          .pipe(response);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', done);
  });
  return { server, url: 'http://127.0.0.1:' + server.address().port + '/' };
}
