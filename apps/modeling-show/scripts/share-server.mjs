// Serves ROOT with the Console share headers (html-shares.ts PUBLIC_MARKDOWN_HEADERS + MIME map).
import { createServer } from 'node:http'; import { gzipSync } from 'node:zlib'; import { readFile } from 'node:fs/promises'; import { extname, join, normalize } from 'node:path';
const root = process.argv[2]; const port = Number(process.argv[3] ?? 5792); const prefix = process.argv[4] ?? '/';
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.json':'application/json', '.wasm':'application/wasm', '.bin':'application/octet-stream', '.glb':'model/gltf-binary', '.png':'image/png', '.webp':'image/webp', '.mp4':'video/mp4', '.svg':'image/svg+xml', '.txt':'text/plain; charset=utf-8' };
const H = { 'content-security-policy':'sandbox allow-scripts', 'access-control-allow-origin':'*', 'referrer-policy':'no-referrer', 'cache-control':'no-store', 'x-content-type-options':'nosniff' };
createServer(async (q, s) => {
  let p = decodeURIComponent(new URL(q.url, 'http://x').pathname);
  if (!p.startsWith(prefix)) { s.writeHead(404, H); s.end('outside prefix'); console.log('404 prefix', p); return; }
  p = p.slice(prefix.length) || 'index.html'; if (p.endsWith('/')) p += 'index.html';
  try { let d = await readFile(join(root, normalize(p))); const media = /\.(mp4|webm|png|webp|jpg)$/i.test(p); const gz = process.env.GZIP === '1' && !media && /gzip/.test(q.headers['accept-encoding'] ?? ''); if (gz) d = gzipSync(d, { level: 1 }); s.writeHead(200, { ...H, 'content-type': mime[extname(p).toLowerCase()] ?? 'application/octet-stream', 'content-length': d.length, ...(gz ? { 'content-encoding': 'gzip' } : {}) }); s.end(q.method === 'HEAD' ? undefined : d); }
  catch { s.writeHead(404, H); s.end(); console.log('404', p); }
}).listen(port, '127.0.0.1', () => console.log('listening', port, prefix));
