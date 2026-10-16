import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  type HttpArtifact,
  HttpArtifactCompression,
  identityAllowed,
  varyEncoding,
} from '@forgeax/engine-vite-plugin-pack/http-artifact';
import type { Plugin } from 'vite';
import type { DistManifest } from './dist.js';

/** Prepare only verified BIN representations; the dist files remain the authority. */
export async function preparePreviewHttpArtifacts(
  root: string,
  manifest: DistManifest,
): Promise<Plugin> {
  const compression = new HttpArtifactCompression();
  const bodies = new Map<string, HttpArtifact>();
  const base = new URL(manifest.base, 'http://localhost/');
  for (const artifact of manifest.artifacts) {
    if (!artifact.path.endsWith('.bin')) continue;
    const path = resolve(root, artifact.path);
    const bytes = await readFile(path);
    if (
      bytes.byteLength !== artifact.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== artifact.sha256
    ) {
      throw new Error(`preview artifact changed after dist verification: ${artifact.path}`);
    }
    const body = { bytes, mimeType: artifact.mediaType };
    await compression.prepare([body]);
    bodies.set(new URL(artifact.path, base).pathname, body);
  }
  return {
    name: 'forgeax:preview-http-artifacts',
    configurePreviewServer(server) {
      server.httpServer.once('close', () => bodies.clear());
      server.middlewares.use((request, response, next) => {
        const body = bodies.get(new URL(request.url ?? '/', 'http://localhost/').pathname);
        if (body === undefined) return next();
        for (const [name, value] of Object.entries(server.config.preview.headers ?? {})) {
          if (value !== undefined) response.setHeader(name, value);
        }
        // Keep Vite's complete static HEAD/Range/conditional response contract.
        varyEncoding(response);
        if (
          request.method !== 'GET' ||
          request.headers.range !== undefined ||
          request.headers['if-none-match'] !== undefined ||
          request.headers['if-modified-since'] !== undefined
        ) {
          if (!identityAllowed(request.headers['accept-encoding'])) {
            response.statusCode = 406;
            response.removeHeader('Content-Encoding');
            response.setHeader('Content-Length', '0');
            response.end();
            return;
          }
          return next();
        }
        compression.send(request, response, body);
      });
    },
  };
}
