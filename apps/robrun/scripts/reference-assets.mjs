import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
export function referenceAssets(reference) {
function install(server) {
const mime = { '.json': 'application/json', '.js': 'text/javascript', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.ktx2': 'image/ktx2', '.woff2': 'font/woff2', '.html': 'text/html' };
server.middlewares.use(async (req, res, next) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  let relative;
  if (path.startsWith('/data/')) relative = path.slice(1);
  else return next();
  const target = resolve(reference, relative.endsWith('/') ? relative + 'index.html' : relative);
  if (!target.startsWith(reference + sep)) { res.statusCode = 403; res.end(); return; }
  try {
    const info = await stat(target);
    if (!info.isFile()) return next();
    const ext = target.slice(target.lastIndexOf('.'));
    res.setHeader('Content-Type', mime[ext] ?? 'application/octet-stream');
    res.setHeader('Content-Length', info.size);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    createReadStream(target).pipe(res);
  } catch { next(); }
});

}
return { name: 'robrun-reference-assets', configureServer: install, configurePreviewServer: install };
}
