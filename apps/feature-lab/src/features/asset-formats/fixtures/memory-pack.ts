import { type AssetRegistry, createCatalogSource } from '@forgeax/engine/assets-runtime';
import { decompressZstd } from '@forgeax/engine/codec';
import { createRuntimePackPublication } from '@forgeax/engine/pack/runtime';

export const PACKAGE_URL = 'https://feature-lab.invalid/asset-formats/lab.pack.json';

export const guid = (index: number): string =>
  `019f2a00-0000-7000-8000-${index.toString(16).padStart(12, '0')}`;

export interface PackArtifact {
  readonly path: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly assetCodec?: Readonly<Record<string, unknown>>;
  readonly contentEncoding?: 'identity' | 'zstd';
  /** Decoded length; defaults to the stored byte count. */
  readonly byteLength?: number;
}

export interface PackEntry {
  readonly guid: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly sourceKey?: string;
  readonly refs?: readonly string[];
  readonly artifacts?: Readonly<Record<string, PackArtifact>>;
}

async function packDocument(entries: readonly PackEntry[]) {
  return {
    schemaVersion: '2.0.0',
    kind: 'internal-text-package',
    assets: await Promise.all(
      entries.map(async (entry) => ({
        guid: entry.guid,
        kind: entry.kind,
        payload: entry.payload,
        refs: entry.refs ?? [],
        artifacts: Object.fromEntries(
          await Promise.all(
            Object.entries(entry.artifacts ?? {}).map(async ([key, artifact]) => {
              let decoded = artifact.bytes;
              if (artifact.contentEncoding === 'zstd') {
                const decompressed = await decompressZstd(artifact.bytes);
                if (!decompressed.ok) throw decompressed.error;
                decoded = decompressed.value;
              }
              const hash = new Uint8Array(
                await crypto.subtle.digest('SHA-256', decoded.slice().buffer),
              );
              return [
                key,
                {
                  path: artifact.path,
                  mediaType: artifact.mediaType,
                  ...(artifact.assetCodec === undefined ? {} : { assetCodec: artifact.assetCodec }),
                  contentEncoding: artifact.contentEncoding ?? 'identity',
                  byteLength: artifact.byteLength ?? artifact.bytes.byteLength,
                  integrity: {
                    algorithm: 'sha256',
                    digest: `sha256:${Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('')}`,
                  },
                },
              ];
            }),
          ),
        ),
      })),
    ),
  };
}

/** Serves one in-memory Pack v2 body and its artifacts to `assets` through a catalog source. */
export async function installMemoryPack(
  assets: AssetRegistry,
  entries: readonly PackEntry[],
  packageUrl: string = PACKAGE_URL,
): Promise<{ readonly fetched: string[] }> {
  const files = new Map<string, Uint8Array>();
  const pack = JSON.parse(
    JSON.stringify(await packDocument(entries), (_key, value) =>
      ArrayBuffer.isView(value) ? Array.from(value as Uint8Array) : value,
    ),
  );
  const publication = createRuntimePackPublication({
    scopeId: 'asset-runtime',
    sourcePath: 'lab',
    sourceRevision: 'fixture',
    packageUrl,
    sourceKeys: new Map(
      entries.flatMap((entry) =>
        entry.sourceKey === undefined ? [] : [[entry.guid, entry.sourceKey]],
      ),
    ),
    pack,
  });
  files.set(
    packageUrl,
    new TextEncoder().encode(
      JSON.stringify(publication.pack, (_key, value) =>
        ArrayBuffer.isView(value) ? Array.from(value as Uint8Array) : value,
      ),
    ),
  );
  for (const entry of entries) {
    for (const artifact of Object.values(entry.artifacts ?? {})) {
      files.set(new URL(artifact.path, packageUrl).href, artifact.bytes);
    }
  }
  const fetched: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    fetched.push(url);
    const bytes = files.get(url);
    return bytes === undefined
      ? new Response('', { status: 404 })
      : new Response(bytes.slice().buffer as ArrayBuffer);
  }) as typeof fetch;
  assets.setCatalogSource(
    createCatalogSource({
      entries: entries.map((entry) => ({
        guid: entry.guid,
        kind: entry.kind,
        packageUrl,
        sourcePath: 'lab',
        publication: publication.publication,
        ...(entry.sourceKey === undefined ? {} : { sourceKey: entry.sourceKey }),
      })),
    }),
    fetcher,
  );
  return { fetched };
}

export function errorCode(error: unknown): string {
  return String((error as { code?: unknown } | undefined)?.code);
}

export function base64Bytes(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** A 16x16 checker of saturated red and blue, RGBA8, used by every texture fixture. */
export function checker(width = 16, height = 16, cell = 4): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const odd = (Math.floor(x / cell) + Math.floor(y / cell)) & 1;
      out.set(odd ? [255, 40, 40, 255] : [40, 80, 255, 255], (y * width + x) * 4);
    }
  }
  return out;
}
