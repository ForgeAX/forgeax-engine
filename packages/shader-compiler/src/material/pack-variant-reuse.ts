import { createHash } from 'node:crypto';
import { deserialize, serialize } from 'node:v8';
import { deflateSync, inflateSync } from 'node:zlib';
import { admitRayMaterial } from '@forgeax/engine-shader';
import {
  type MaterialAsset,
  ok,
  type Result,
  resolveMaterialAsset,
  selectMaterialStaticContract,
} from '@forgeax/engine-types';
import type { compileShader } from '../compile.js';
import { freezeSnapshot } from '../frozen.js';
import {
  cookMaterialAsset,
  type MaterialCookedAsset,
  type MaterialCookRequest,
  type MaterialSurfacePreparation,
} from './cook.js';
import {
  type CookedRayMaterial,
  cookRayMaterial,
  type RayMaterialCookRequest,
} from './ray-material.js';
import { deriveSurfaceShadowPasses } from './surface-shadow.js';

// Two Standard contracts can exceed 128 context entries before approaching the
// byte limit. Keep their working sets resident through a schema transition;
// each entry still pays its actual compressed payload bytes.
const MAX_ENTRIES = 256;
const MAX_RETAINED_BYTES = 64 * 1024 * 1024;

/** Unknown live objects keep the original compiler's observations. */
function plainJson(value: unknown, visiting = new Set<object>()): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value !== 'object') return typeof value === 'string' || typeof value === 'boolean';
  // Uniform texture/sampler GUIDs are detached 16-byte identities, not compiler code.
  if (value instanceof Uint8Array && Object.getPrototypeOf(value) === Uint8Array.prototype)
    return (
      value.byteLength === 16 &&
      value.buffer instanceof ArrayBuffer &&
      Reflect.ownKeys(value).length === 16
    );
  if (visiting.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype)
    return false;
  visiting.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !('value' in descriptor) ||
      !plainJson(descriptor.value, visiting)
    )
      return false;
  }
  visiting.delete(value);
  return true;
}

/** Hash only detached file/declaration data without observing author accessors. */
export function materialPackSourceIdentity(input: unknown): string | undefined {
  if (!plainJson(input)) return undefined;
  const text = JSON.stringify(input);
  return text === undefined ? undefined : createHash('sha256').update(text).digest('hex');
}

function detachedMaterialCookInputs(
  request: MaterialCookRequest,
  selectedPasses: readonly string[] | undefined,
): boolean {
  return plainJson(request.table) && plainJson(request.context) && plainJson(selectedPasses);
}

function contractKey(asset: MaterialAsset): string | undefined {
  const prototype = Object.getPrototypeOf(asset);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const fields = Object.getOwnPropertyDescriptors(asset);
  const contract: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(fields)) {
    if (typeof key !== 'string') return undefined;
    if (key === 'values') continue;
    const field = fields[key];
    if (field === undefined || !('value' in field) || !plainJson(field.value)) return undefined;
    Object.defineProperty(contract, key, { value: field.value, enumerable: true });
  }
  return JSON.stringify(contract);
}

/** Decoding the private cache yields a detached graph of previously validated data. */
function freezeDecodedVariant<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDecodedVariant(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Pack owns fresh source bytes; GUIDs and uniform values remain per-publication data.
 * Keys include the complete source identity, so Packs with equal sources share
 * compiled variants even when other Packs cook in between, and concurrent Packs
 * asking for one variant wait for a single compilation. Retention stays bounded
 * by entry count and bytes across all identities.
 */
export function createMaterialPackVariantCompiler(compile: typeof compileShader) {
  type Retained = {
    readonly payload: Uint8Array;
    readonly bytes: number;
  };
  const variants = new Map<string, Retained>();
  const compiling = new Map<string, Promise<void>>();
  let heldBytes = 0;
  const retain = (key: string, value: unknown): void => {
    // Detach and validate plain data before retaining its private encoding.
    const snapshot = freezeSnapshot(value);
    if (snapshot === undefined) return;
    if (snapshot.bytes > MAX_RETAINED_BYTES) return;
    // Keep source text compressed while idle. Expanded context rosters can
    // exceed the retained byte budget even after sharing equal WGSL strings.
    // This is a private cache encoding, not a published program or new IR.
    const encoded = serialize(snapshot.value);
    if (encoded.byteLength > MAX_RETAINED_BYTES) return;
    const payload = deflateSync(encoded, { level: 1 });
    const bytes = payload.byteLength;
    if (bytes > MAX_RETAINED_BYTES) return;
    while (variants.size >= MAX_ENTRIES || heldBytes + bytes > MAX_RETAINED_BYTES) {
      const oldest = variants.keys().next().value;
      if (oldest === undefined) break;
      heldBytes -= variants.get(oldest)?.bytes ?? 0;
      variants.delete(oldest);
    }
    heldBytes -= variants.get(key)?.bytes ?? 0;
    variants.set(key, { payload, bytes });
    heldBytes += bytes;
  };
  const reuse = async <T, P, E>(options: {
    readonly key: string | undefined;
    readonly cook: () => Promise<Result<T, E>>;
    readonly stillCurrent: () => boolean;
    readonly save: (result: T) => P;
    readonly restore: (stored: P) => T;
  }): Promise<Result<T, E>> => {
    const { key } = options;
    if (key === undefined) return options.cook();
    // Concurrent consumers share successful prepared bytes. Failures never
    // enter the cache and do not overwrite a later retry.
    const inFlight = compiling.get(key);
    if (inFlight !== undefined && !variants.has(key)) await inFlight;
    const previous = variants.get(key);
    if (previous !== undefined) {
      variants.delete(key);
      variants.set(key, previous);
      const decoded = freezeDecodedVariant(
        deserialize(inflateSync(previous.payload, { maxOutputLength: MAX_RETAINED_BYTES })) as P,
      );
      return ok(options.restore(decoded));
    }
    let settle: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    compiling.set(key, done);
    try {
      const result = await options.cook();
      if (result.ok && options.stillCurrent()) retain(key, options.save(result.value));
      return result;
    } finally {
      if (compiling.get(key) === done) compiling.delete(key);
      settle?.();
    }
  };

  const raster = async (
    request: MaterialCookRequest,
    sourceIdentity: string | undefined,
    selectedPasses?: readonly string[],
    preparedSurfaces?: MaterialSurfacePreparation,
  ) => {
    if (
      sourceIdentity === undefined ||
      !detachedMaterialCookInputs(request, selectedPasses) ||
      (request.vertexColorAvailable !== undefined &&
        typeof request.vertexColorAvailable !== 'boolean')
    )
      return cookMaterialAsset(request, compile, selectedPasses);
    const resolved = resolveMaterialAsset(request.material, request.table);
    if (!resolved.ok) return resolved;
    const contract = contractKey(resolved.value.asset);
    const keyFor = (contract: string) =>
      createHash('sha256')
        .update(
          JSON.stringify([
            sourceIdentity,
            contract,
            request.context,
            request.vertexColorAvailable,
            selectedPasses === undefined ? undefined : [...new Set(selectedPasses)].sort(),
          ]),
        )
        .digest('hex');
    const key = contract === undefined ? undefined : keyFor(contract);
    return reuse({
      key,
      cook: () => cookMaterialAsset(request, compile, selectedPasses, preparedSurfaces),
      stillCurrent: () => {
        if (!detachedMaterialCookInputs(request, selectedPasses)) return false;
        const current = resolveMaterialAsset(request.material, request.table);
        const currentContract = current.ok ? contractKey(current.value.asset) : undefined;
        return currentContract !== undefined && keyFor(currentContract) === key;
      },
      save: (cooked: MaterialCookedAsset) => ({
        passes: cooked.passes,
        layerPlan: cooked.layerPlan,
      }),
      restore: (previous) => ({
        ...previous,
        resolved: {
          ...resolved.value,
          asset: deriveSurfaceShadowPasses(selectMaterialStaticContract(resolved.value.asset)),
        },
      }),
    });
  };
  const ray = async (request: RayMaterialCookRequest, sourceIdentity: string | undefined) => {
    if (sourceIdentity === undefined || !plainJson(request.table) || !plainJson(request.context))
      return cookRayMaterial(request, compile);
    const resolved = resolveMaterialAsset(request.material, request.table);
    if (!resolved.ok) return resolved;
    const asset = selectMaterialStaticContract(resolved.value.asset);
    const context = request.context ?? 'ray-hit';
    const admission = admitRayMaterial(asset, request.material, context);
    if (!admission.ok) return admission;
    const contract = contractKey(resolved.value.asset);
    const key =
      contract === undefined
        ? undefined
        : createHash('sha256')
            .update(JSON.stringify([sourceIdentity, contract, 'ray', context]))
            .digest('hex');
    return reuse({
      key,
      cook: () => cookRayMaterial(request, compile),
      stillCurrent: () => {
        if (!plainJson(request.table)) return false;
        const current = resolveMaterialAsset(request.material, request.table);
        return (
          current.ok &&
          contractKey(current.value.asset) === contract &&
          (request.context ?? 'ray-hit') === context
        );
      },
      save: (cooked: CookedRayMaterial) => ({
        program: cooked.program,
        sourceClosure: cooked.sourceClosure,
      }),
      restore: (previous) => ({ ...previous, asset }),
    });
  };
  return { raster, ray };
}
