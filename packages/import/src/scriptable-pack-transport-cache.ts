import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { deserialize, Serializer } from 'node:v8';
import { brotliCompress, brotliDecompress, constants } from 'node:zlib';
import { DdcEntryStore, ddcOutputDigest, semanticDdcKey } from '@forgeax/engine-ddc';
import type { finalizePackageTransportSource } from '@forgeax/engine-pack/build';
import { PackageId } from '@forgeax/engine-pack/source';
import type { ScriptablePackBuildProduct } from './scriptable-pack-build-core.js';
import type { ScriptablePackInput } from './scriptable-pack-host.js';
import {
  createProductRelocation,
  shareImmutableProductData,
} from './scriptable-pack-product-cache.js';

type Transport = Awaited<ReturnType<typeof finalizePackageTransportSource>>;
type StoredArtifact = Omit<Transport['artifacts'][number], 'bytes'> & {
  readonly byteLength: number;
  readonly digest: string;
};
type StoredTransport = Omit<Transport, 'artifacts'> & {
  readonly artifacts: readonly StoredArtifact[];
};
const SCHEMA = 'scriptable-pack-transport/1';
const BODY = 'transport.v8.br';
const compress = promisify(brotliCompress);
const decompress = promisify(brotliDecompress);
let ownerIdentity: Promise<string | undefined> | undefined;
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Cache the projection, never a second copy of the producer's binary artifacts. */
export async function createScriptablePackTransportCache(options: {
  readonly root: string;
  readonly identityRoot?: string;
  readonly canReuse: (product: ScriptablePackBuildProduct) => boolean;
}) {
  const identityRoot = options.identityRoot;
  const roots =
    identityRoot === undefined
      ? []
      : [await realpath(identityRoot).catch(() => resolve(identityRoot)), resolve(identityRoot)];
  const relocation = roots.length === 0 ? undefined : createProductRelocation(roots);
  const store = new DdcEntryStore(join(options.root, 'scriptable-pack-transports'));
  ownerIdentity ??= Promise.all([
    readFile(fileURLToPath(import.meta.url)),
    readFile(fileURLToPath(import.meta.resolve('@forgeax/engine-pack/build'))),
  ])
    .then(([owner, pack]) => createHash('sha256').update(owner).update(pack).digest('hex'))
    .catch(() => undefined);
  const identity = async (source: ScriptablePackInput, product: ScriptablePackBuildProduct) => {
    const owner = await ownerIdentity;
    if (
      !source.transportIdentity?.trim() ||
      !source.sourceClosure.length ||
      !options.canReuse(product) ||
      owner === undefined
    )
      return undefined;
    const guid = PackageId.format(source.subjectPackageId ?? source.definition.packageId);
    const key = semanticDdcKey({
      schemaVersion: SCHEMA,
      importer: 'scriptable-pack-transport',
      codec: `node-v8/${process.versions.v8}`,
      settings: {
        owner,
        locationSlots: roots.length,
        policy: source.transportIdentity,
        generation: source.publicationGeneration,
      },
      sourceBytes: [
        new TextEncoder().encode(product.inputFingerprint),
        new TextEncoder().encode(
          roots[0] === undefined
            ? source.sourcePath
            : relative(roots[0], source.sourcePath).replaceAll('\\', '/'),
        ),
      ],
      declaredGuids: [guid],
      targetProfile: 'dev',
      producer: SCHEMA,
    });
    return { key, guid };
  };
  const timing = (state: string, source: ScriptablePackInput, started: number) => {
    if (process.env.FORGEAX_WORKSPACE_TIMING === '1')
      console.error(
        '[forgeax.pack-transport.timing]',
        JSON.stringify({
          state,
          sourcePath: source.sourcePath,
          elapsedMs: Math.round(performance.now() - started),
        }),
      );
  };
  return {
    async read(
      source: ScriptablePackInput,
      product: ScriptablePackBuildProduct,
    ): Promise<Transport | undefined> {
      const started = performance.now();
      try {
        const id = await identity(source, product);
        if (id === undefined) return undefined;
        const entry = await store.read(id.key),
          body = entry?.artifacts[BODY]?.bytes;
        if (entry?.guid !== id.guid || body === undefined) {
          timing('miss', source, started);
          return undefined;
        }
        const decoded = await decompress(body);
        const stored = deserialize(decoded) as StoredTransport;
        const data = relocation === undefined ? stored : relocation.restore(decoded, stored);
        if (
          data?.pack?.schemaVersion !== '2.0.0' ||
          !Array.isArray(data.artifacts) ||
          typeof data.digest !== 'string'
        )
          return undefined;
        const assets = new Map(product.product.assets.map((asset) => [asset.guid, asset]));
        const digests = new WeakMap<Uint8Array, string>();
        const artifacts: Transport['artifacts'] = [];
        for (const { byteLength, digest, ...artifact } of data.artifacts) {
          const bytes = assets.get(artifact.guid)?.artifacts[artifact.localKey]?.bytes;
          if (bytes === undefined || bytes.byteLength !== byteLength) return undefined;
          let actual = digests.get(bytes);
          if (actual === undefined) {
            actual = hash(bytes);
            digests.set(bytes, actual);
          }
          if (actual !== digest) return undefined;
          artifacts.push({ ...artifact, bytes });
        }
        timing('hit', source, started);
        return { ...data, artifacts };
      } catch {
        return undefined;
      }
    },
    async write(
      source: ScriptablePackInput,
      product: ScriptablePackBuildProduct,
      transport: Transport,
    ): Promise<void> {
      const started = performance.now();
      try {
        const id = await identity(source, product);
        if (id === undefined) return;
        const digests = new WeakMap<Uint8Array, string>();
        const artifacts = transport.artifacts.map(({ bytes, ...artifact }) => {
          let digest = digests.get(bytes);
          if (digest === undefined) {
            digest = hash(bytes);
            digests.set(bytes, digest);
          }
          return { ...artifact, byteLength: bytes.byteLength, digest };
        });
        const value = shareImmutableProductData({ ...transport, artifacts }, relocation?.store);
        const serializer = new Serializer();
        serializer.writeHeader();
        serializer.writeValue(value);
        const encoded = serializer.releaseBuffer();
        if (encoded.byteLength > 128 * 1024 ** 2 || relocation?.locationBound(encoded)) return;
        const bytes = await compress(encoded, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } });
        const entry = {
          key: id.key,
          guid: id.guid,
          payload: { schemaVersion: SCHEMA },
          refs: [] as string[],
          artifacts: { [BODY]: { mediaType: 'application/vnd.node-v8-serialized+br', bytes } },
          receipt: {
            guid: id.guid,
            key: id.key,
            producer: SCHEMA,
            inputFingerprint: product.inputFingerprint,
            outputDigest: '',
          },
        };
        entry.receipt.outputDigest = ddcOutputDigest(entry);
        await store.write(entry);
        timing('write', source, started);
      } catch {
        timing('write-failed', source, started);
      }
    },
  };
}
