import { createHash } from 'node:crypto';
import { type MaterialAsset, ok, selectMaterialStaticContract } from '@forgeax/engine-types';
import type { compileShader } from '../compile.js';
import { cookMaterialAsset, type MaterialCookedAsset, type MaterialCookRequest } from './cook.js';
import { resolveMaterialAsset } from './resolve.js';
import { deriveSurfaceShadowPasses } from './surface-shadow.js';

const MAX_ENTRIES = 128;
// The complete authored rigid material has twenty raster contexts. A 16 MiB
// roster evicts its first context before the next value-only material arrives.
// This fixed budget covers that measured working set without unbounded growth.
const MAX_RETAINED_BYTES = 64 * 1024 * 1024;

/** Unknown live objects keep the original compiler's observations. */
function plainJson(value: unknown, visiting = new Set<object>()): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value !== 'object') return typeof value === 'string' || typeof value === 'boolean';
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

function retainedBytes(asset: Pick<MaterialCookedAsset, 'passes' | 'layerPlan'>): number {
  // Charge repeated strings and metadata conservatively as UTF-16 payload.
  // Object/header overhead has the independent entry-count bound.
  return JSON.stringify(asset).length * 2;
}

/** Pack owns fresh source bytes; GUIDs and uniform values remain per-publication data. */
export function createMaterialPackVariantCompiler(compile: typeof compileShader) {
  const variants = new Map<
    string,
    {
      readonly asset: Pick<MaterialCookedAsset, 'passes' | 'layerPlan'>;
      readonly bytes: number;
    }
  >();
  let heldBytes = 0;
  let namespace: string | undefined;
  let generation = 0;
  return async (request: MaterialCookRequest, sourceIdentity: string | undefined) => {
    if (
      sourceIdentity === undefined ||
      !plainJson(request.table) ||
      !plainJson(request.context) ||
      (request.vertexColorAvailable !== undefined &&
        typeof request.vertexColorAvailable !== 'boolean')
    )
      return cookMaterialAsset(request, compile);
    if (namespace !== sourceIdentity) {
      variants.clear();
      heldBytes = 0;
      namespace = sourceIdentity;
      generation++;
    }
    const ticket = generation;
    const resolved = resolveMaterialAsset(request.material, request.table);
    if (!resolved.ok) return resolved;
    const contract = contractKey(resolved.value.asset);
    const keyFor = (contract: string) =>
      createHash('sha256')
        .update(
          JSON.stringify([sourceIdentity, contract, request.context, request.vertexColorAvailable]),
        )
        .digest('hex');
    const key = contract === undefined ? undefined : keyFor(contract);
    const previous = key === undefined ? undefined : variants.get(key);
    if (key !== undefined && previous !== undefined) {
      variants.delete(key);
      variants.set(key, previous);
      // Compilation has no uniform-value input. Re-resolve and select this
      // material's current values and refs before its independent publication.
      return ok({
        ...structuredClone(previous.asset),
        resolved: {
          ...resolved.value,
          asset: deriveSurfaceShadowPasses(selectMaterialStaticContract(resolved.value.asset)),
        },
      });
    }
    const cooked = await cookMaterialAsset(request, compile);
    if (!cooked.ok || key === undefined) return cooked;
    // A source replacement during an awaited compilation must not re-admit
    // the superseded namespace, including an A -> B -> A replacement.
    if (ticket !== generation) return cooked;
    if (!plainJson(request.table) || !plainJson(request.context)) return cooked;
    const current = resolveMaterialAsset(request.material, request.table);
    const currentContract = current.ok ? contractKey(current.value.asset) : undefined;
    if (currentContract === undefined || keyFor(currentContract) !== key) return cooked;
    let asset: Pick<MaterialCookedAsset, 'passes' | 'layerPlan'>;
    let bytes: number;
    try {
      asset = structuredClone({ passes: cooked.value.passes, layerPlan: cooked.value.layerPlan });
      bytes = retainedBytes(asset);
    } catch {
      return cooked;
    }
    if (bytes > MAX_RETAINED_BYTES) return cooked;
    while (variants.size >= MAX_ENTRIES || heldBytes + bytes > MAX_RETAINED_BYTES) {
      const oldest = variants.keys().next().value;
      if (oldest === undefined) break;
      heldBytes -= variants.get(oldest)?.bytes ?? 0;
      variants.delete(oldest);
    }
    heldBytes -= variants.get(key)?.bytes ?? 0;
    variants.set(key, { asset, bytes });
    heldBytes += bytes;
    return cooked;
  };
}
