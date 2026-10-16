import {
  type CookedMaterialRecord,
  collectMaterialCookRefs,
  createMaterialArtifactDigest,
  type MaterialCookWasmProvenance,
  serializeCookedMaterialRecord,
  serializeMaterialCookReceipt,
} from '@forgeax/engine-pack/material-cook';
import type { CookProduct, MaterialAsset, MaterialTable } from '@forgeax/engine-types';
import type { MaterialCookedAsset } from './cook.js';
import { cookedRecord, materialPrograms } from './publication.js';
import { resolveMaterialAsset } from './resolve.js';

export {
  type CookedMaterialRecord,
  collectMaterialCookRefs,
  createMaterialArtifactDigest,
  type MaterialCookArtifact,
  type MaterialCookReceipt,
  type MaterialCookRefs,
} from '@forgeax/engine-pack/material-cook';

export interface MaterialCookRequest {
  readonly guid: string;
  readonly sourceClosure: readonly string[];
  readonly profile: string;
  readonly compilerVersion: string;
  readonly material: MaterialAsset;
  readonly table?: MaterialTable;
  readonly moduleSources?: Readonly<Record<string, string>>;
  readonly sourceRevision?: string;
  readonly sourceClosureDigest?: string;
  readonly compilerFingerprint?: string;
  readonly wasm?: MaterialCookWasmProvenance;
  readonly valueGeneration?: number;
  readonly dependencyGeneration?: number;
  /** Geometry-owned COLOR_0 fact; it changes the compiled ABI and cache key. */
  readonly vertexColorAvailable?: boolean;
}

export interface MaterialCookCatalogEntry {
  readonly guid: string;
  readonly key: string;
  readonly artifactDigest: string;
}

export interface MaterialCookPublication {
  readonly cache: 'cold' | 'hit';
  readonly key: string;
  readonly record: CookedMaterialRecord;
  readonly recordBytes: Uint8Array;
  readonly receiptBytes: Uint8Array;
  readonly catalog: MaterialCookCatalogEntry;
}

export interface MaterialNativeCookerOptions {
  readonly compile: (request: MaterialCookRequest) => Promise<MaterialCookedAsset>;
}

const publications = new WeakMap<object, MaterialCookPublication>();
const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
const digest = (value: unknown): string => createMaterialArtifactDigest(encode(canonical(value)));

export function materialCookPublication(
  product: CookProduct<MaterialAsset>,
): MaterialCookPublication | undefined {
  return publications.get(product);
}

/** Both disk and injected producers publish the same complete compiled program set. */
export function createMaterialNativeCooker(options: MaterialNativeCookerOptions) {
  const compilations = new Map<string, MaterialCookedAsset>();
  const products = new Map<string, CookProduct<MaterialAsset>>();
  const generations = new Map<string, number>();
  return {
    async cook(request: MaterialCookRequest): Promise<CookProduct<MaterialAsset>> {
      const resolved = resolveMaterialAsset(request.guid, {
        ...request.table,
        [request.guid]: request.material,
      }).unwrap();
      const compilationKey = digest({
        colorSpace: resolved.asset.colorSpace,
        parameters: resolved.asset.parameters?.map(
          ({ default: _default, ...parameter }) => parameter,
        ),
        passes: resolved.asset.passes?.map(({ renderState, ...pass }) => ({
          ...pass,
          tags: renderState?.tags,
        })),
        sources: request.moduleSources,
        closure: request.sourceClosureDigest,
        profile: request.profile,
        compiler: request.compilerVersion,
        fingerprint: request.compilerFingerprint,
        wasm: request.wasm,
        vertexColorAvailable: request.vertexColorAvailable,
      });
      // Without a content snapshot, do not infer unchanged shader inputs from file names.
      const cacheable =
        request.moduleSources !== undefined || request.sourceClosureDigest !== undefined;
      const previous = cacheable ? compilations.get(compilationKey) : undefined;
      const compiled = previous ?? (await options.compile(request));
      const sourceClosureDigest =
        request.sourceClosureDigest ??
        digest(compiled.passes.map((pass) => pass.sourceClosureDigest).sort());
      const publicationInput = { ...request, source: request.material };
      const programs = materialPrograms(compiled.passes, publicationInput);
      const layoutIdentity = compiled.passes[0]?.layoutIdentity;
      if (
        layoutIdentity === undefined ||
        compiled.passes.some((pass) => pass.layoutIdentity !== layoutIdentity)
      )
        throw new Error('material program set must share one root parameter layout');
      const publicationKey = digest({
        request: { ...request, table: undefined },
        resolved: resolved.asset,
        programs: programs.map(({ artifact, ...program }) => ({
          ...program,
          artifact: artifact.digest,
        })),
      });
      const existing = products.get(publicationKey);
      if (existing !== undefined) {
        const publication = publications.get(existing);
        if (publication !== undefined) publications.set(existing, { ...publication, cache: 'hit' });
        return existing;
      }
      const generation = (generations.get(request.guid) ?? 0) + 1;
      const record = cookedRecord(
        { ...publicationInput, cookGeneration: generation },
        resolved.asset,
        request.sourceClosure,
        layoutIdentity,
        programs,
        sourceClosureDigest,
        compiled.layerPlan.identity,
      );
      if (cacheable) compilations.set(compilationKey, compiled);
      const artifactDigest = record.receipt.identity.artifactDigest;
      const key = artifactDigest;
      const refs = collectMaterialCookRefs(resolved.asset);
      const product: CookProduct<MaterialAsset> = {
        guid: request.guid,
        payload: request.material,
        refs: [
          ...new Set([...record.refs.parent, ...refs.textures, ...refs.samplers, ...refs.modules]),
        ],
        artifacts: Object.fromEntries(
          programs.map(({ artifact }) => [
            artifact.path,
            {
              path: artifact.path,
              mediaType: artifact.mediaType,
              byteLength: artifact.bytes.byteLength,
              integrity: { algorithm: 'sha256' as const, digest: artifact.digest },
            },
          ]),
        ),
        digest: artifactDigest,
        receipt: {
          guid: request.guid,
          origin: 'authoredPack',
          status: 'succeeded',
          inputFingerprint: record.receipt.identity.cookIdentity,
          outputDigest: artifactDigest,
        },
      };
      publications.set(product, {
        cache: previous === undefined ? 'cold' : 'hit',
        key,
        record,
        recordBytes: encode(serializeCookedMaterialRecord(record)),
        receiptBytes: encode(serializeMaterialCookReceipt(record.receipt)),
        catalog: { guid: request.guid, key, artifactDigest },
      });
      products.set(publicationKey, product);
      generations.set(request.guid, generation);
      return product;
    },
  };
}
