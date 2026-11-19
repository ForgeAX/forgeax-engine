import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { compressZstd } from '@forgeax/engine-codec/encode';
import { build } from 'vite';
import type { SingleHtmlBundleArtifact } from './single-html';

interface StoredBody {
  readonly bytes: Uint8Array;
  readonly encoding?: 'gzip' | 'zstd';
  readonly decodedByteLength?: number;
}

interface StoredResource {
  readonly path: string;
  readonly mime: string;
  readonly moduleLinks?: SingleHtmlBundleArtifact['moduleLinks'];
  readonly index: number;
  readonly encoding?: 'gzip' | 'zstd';
  readonly decodedByteLength?: number;
  readonly offset?: number;
  readonly length?: number;
}

let decoderSource: Promise<string> | undefined;
function prepareDecoderSource(): Promise<string> {
  decoderSource ??= (async () => {
    const entry = fileURLToPath(import.meta.resolve('fzstd'));
    const result = await build({
      configFile: false,
      logLevel: 'error',
      build: {
        write: false,
        minify: true,
        target: 'esnext',
        lib: { entry, name: '__forgeaxZstd', formats: ['iife'] },
      },
    });
    const output = Array.isArray(result) ? result[0] : result;
    if (output === undefined || !('output' in output))
      throw Error('Single HTML Zstd decoder was not emitted');
    const chunk = output.output.find((row) => row.type === 'chunk');
    if (chunk?.type !== 'chunk') throw Error('Single HTML Zstd decoder entry is missing');
    const license = await readFile(resolve(dirname(entry), '../LICENSE'), 'utf8');
    return `/* fzstd (MIT)\n${license.replaceAll('*/', '* /')}\n*/\n${chunk.code}`;
  })().catch((cause) => {
    decoderSource = undefined;
    throw cause;
  });
  return decoderSource;
}

/** Store exact resource bytes; shared compression does not alter module or asset identity. */
export async function prepareSingleHtmlStorage(
  resources: readonly SingleHtmlBundleArtifact[],
  digest: (bytes: Uint8Array) => string,
): Promise<{
  readonly entries: readonly StoredResource[];
  readonly bodies: readonly StoredBody[];
  readonly decoder: string;
}> {
  const unique: SingleHtmlBundleArtifact[] = [];
  const identities = new Map<string, number>();
  const resourceBodies = resources.map((resource) => {
    const key = digest(resource.bytes);
    let index = identities.get(key);
    if (index === undefined) {
      index = unique.length;
      unique.push(resource);
      identities.set(key, index);
    }
    return index;
  });
  const compressed: StoredBody[] = unique.map((resource) => {
    const gzip = gzipSync(resource.bytes, { level: 9 });
    return gzip.byteLength < resource.bytes.byteLength * 0.9
      ? { bytes: gzip, encoding: 'gzip' }
      : { bytes: resource.bytes };
  });
  const scripts = unique
    .map((resource, index) => ({ resource, index }))
    .filter(({ resource }) => /\.[cm]?js$/i.test(resource.path));
  const scriptBytes = scripts.reduce((sum, { resource }) => sum + resource.bytes.byteLength, 0);
  let decoder = '';
  let archive: StoredBody | undefined;
  // Bound retained decoded transport bytes; larger closures keep independent storage.
  if (scriptBytes >= 1024 * 1024 && scriptBytes <= 64 * 1024 * 1024) {
    const source = Buffer.concat(scripts.map(({ resource }) => resource.bytes));
    const encoded = await compressZstd(source, { level: 19 });
    if (!encoded.ok) throw encoded.error;
    const independent = scripts.reduce(
      (sum, { index }) => sum + (compressed[index]?.bytes.byteLength ?? 0),
      0,
    );
    if (encoded.value.byteLength + 16384 < independent * 0.9) {
      decoder = await prepareDecoderSource();
      archive = { bytes: encoded.value, encoding: 'zstd', decodedByteLength: scriptBytes };
    }
  }
  const bodies: StoredBody[] = archive === undefined ? [] : [archive];
  const locations = new Map<number, Omit<StoredResource, 'path' | 'mime'>>();
  if (archive !== undefined) {
    let offset = 0;
    for (const { resource, index } of scripts) {
      locations.set(index, {
        index: 0,
        encoding: 'zstd',
        decodedByteLength: scriptBytes,
        offset,
        length: resource.bytes.byteLength,
      });
      offset += resource.bytes.byteLength;
    }
  }
  for (const [index, resource] of unique.entries()) {
    if (locations.has(index)) continue;
    let stored = compressed[index];
    if (stored === undefined) throw Error('Single HTML storage body is missing');
    if (
      archive !== undefined &&
      /\.wasm$/i.test(resource.path) &&
      resource.bytes.byteLength >= 128 * 1024
    ) {
      const encoded = await compressZstd(resource.bytes, { level: 19 });
      if (!encoded.ok) throw encoded.error;
      if (encoded.value.byteLength < stored.bytes.byteLength * 0.9)
        stored = {
          bytes: encoded.value,
          encoding: 'zstd',
          decodedByteLength: resource.bytes.byteLength,
        };
    }
    locations.set(index, {
      index: bodies.length,
      ...(stored.encoding === undefined ? {} : { encoding: stored.encoding }),
      ...(stored.decodedByteLength === undefined
        ? {}
        : { decodedByteLength: stored.decodedByteLength }),
    });
    bodies.push(stored);
  }
  return {
    entries: resources.map((resource, index) => {
      const location = locations.get(resourceBodies[index] ?? -1);
      if (location === undefined) throw Error('Single HTML resource location is missing');
      return {
        path: resource.path,
        mime: resource.mediaType,
        ...(resource.moduleLinks === undefined ? {} : { moduleLinks: resource.moduleLinks }),
        ...location,
      };
    }),
    bodies,
    decoder,
  };
}
