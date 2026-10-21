import { createHash } from 'node:crypto';
import type { AssetEnvelopeV2, PackV2 } from '@forgeax/engine-types';

interface TransportArtifact {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** A project may opt in only source families whose measured read order suits chunks. */
export function meshChunkingRequested(
  value: string | undefined,
  sourcePath: string | undefined,
): boolean {
  if (value === '1') return true;
  if (!value || value === '0' || sourcePath === undefined) return false;
  const normalize = (path: string) => path.replaceAll('\\', '/').replace(/^\.\//, '');
  return normalize(sourcePath).startsWith(normalize(value));
}

/** Physical delivery only: asset identity, decoded bytes and individual integrity stay unchanged. */
export function chunkMeshArtifacts(
  source: unknown,
  artifacts: readonly TransportArtifact[],
  assetOrder: readonly string[] = [],
): { readonly pack: unknown; readonly artifacts: readonly TransportArtifact[] } {
  if (source === null || typeof source !== 'object') return { pack: source, artifacts };
  const candidate = source as Partial<PackV2>;
  if (candidate.schemaVersion !== '2.0.0' || !Array.isArray(candidate.assets))
    return { pack: source, artifacts };
  const pack = source as PackV2;
  const bodies = new Map(artifacts.map((artifact) => [artifact.path, artifact.bytes]));
  const order = new Map(assetOrder.map((guid, index) => [guid, index]));
  const assets = [...pack.assets].sort(
    (a, b) => (order.get(a.guid) ?? Infinity) - (order.get(b.guid) ?? Infinity),
  );
  const selected = new Map<string, Uint8Array>();
  const unbundled = new Set<string>();
  for (const asset of assets) {
    for (const descriptor of Object.values(asset.artifacts ?? {})) {
      const bytes = bodies.get(descriptor.path);
      if (
        asset.kind === 'mesh' &&
        descriptor.delivery === undefined &&
        descriptor.byteRange === undefined &&
        descriptor.contentEncoding === 'identity' &&
        descriptor.integrity?.algorithm === 'sha256' &&
        bytes !== undefined &&
        bytes.byteLength > 0 &&
        bytes.byteLength <= 8 * 1024
      )
        selected.set(descriptor.path, bytes);
      else unbundled.add(descriptor.path);
    }
  }
  for (const path of unbundled) selected.delete(path);
  const windows = new Map<
    string,
    { path: string; byteRange: { offset: number; length: number; containerDigest: string } }
  >();
  const chunks: TransportArtifact[] = [];
  let pending: [string, Uint8Array][] = [];
  let size = 0;
  const flush = () => {
    if (pending.length >= 4) {
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const [, body] of pending) {
        bytes.set(body, offset);
        offset += body.byteLength;
      }
      const hash = createHash('sha256').update(bytes).digest('hex');
      const path = `shared/chunks/${hash}.bin`;
      offset = 0;
      for (const [original, body] of pending) {
        windows.set(original, {
          path,
          byteRange: { offset, length: body.byteLength, containerDigest: `sha256:${hash}` },
        });
        offset += body.byteLength;
      }
      chunks.push({ path, bytes });
    }
    pending = [];
    size = 0;
  };
  for (const entry of selected) {
    if (size + entry[1].byteLength > 64 * 1024) flush();
    pending.push(entry);
    size += entry[1].byteLength;
  }
  flush();
  if (!windows.size) return { pack: source, artifacts };
  return {
    pack: {
      ...pack,
      assets: pack.assets.map(
        (asset): AssetEnvelopeV2 => ({
          ...asset,
          artifacts: Object.fromEntries(
            Object.entries(asset.artifacts ?? {}).map(([key, descriptor]) => [
              key,
              asset.kind === 'mesh' &&
              !unbundled.has(descriptor.path) &&
              windows.has(descriptor.path)
                ? { ...descriptor, ...windows.get(descriptor.path) }
                : descriptor,
            ]),
          ),
        }),
      ),
    },
    artifacts: [
      ...artifacts.filter(({ path }) => !windows.has(path) || unbundled.has(path)),
      ...chunks,
    ],
  };
}
