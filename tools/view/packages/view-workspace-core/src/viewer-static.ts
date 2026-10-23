import { existsSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';

/**
 * The viewer build leaves Engine-owned generated binaries out of `dist/viewer`
 * and keeps their hashed URLs as `assets/engine/<package-dir>/<hash>/<file>`.
 * View servers read the bytes from that package's `pkg/` in the exact-version
 * Engine installation, which bundles every Engine owner under its own
 * `node_modules/@forgeax/`, instead of shipping a second copy.
 */
const ENGINE_PACKAGE_ASSET = /^\/assets\/engine\/([a-z0-9-]+)\/[\w-]+\/([\w-]+(?:\.[\w-]+)+)$/;

const STATIC_MIME: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
});

export function viewerContentType(filePath: string) {
  const index = filePath.lastIndexOf('.');
  if (index === -1) return 'application/octet-stream';
  return STATIC_MIME[filePath.slice(index)] ?? 'application/octet-stream';
}

function regularFile(path: string): string | undefined {
  return existsSync(path) && statSync(path).isFile() ? path : undefined;
}

/** A regular file served for `pathname`, from the viewer root or the Engine root. */
export function resolveViewerFile(
  staticRoot: string,
  pathname: string,
  engineRoot?: string,
): string | undefined {
  const engineAsset = ENGINE_PACKAGE_ASSET.exec(pathname);
  if (engineAsset !== null) {
    const [, directory, file] = engineAsset as unknown as [string, string, string];
    return engineRoot === undefined
      ? undefined
      : regularFile(join(engineRoot, 'node_modules', '@forgeax', `engine-${directory}`, 'pkg', file));
  }
  const relative = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, '');
  const absolute = join(staticRoot, relative);
  if (!absolute.startsWith(staticRoot)) return undefined;
  return regularFile(absolute);
}
