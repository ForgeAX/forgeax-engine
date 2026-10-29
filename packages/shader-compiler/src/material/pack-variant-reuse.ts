import { createHash } from 'node:crypto';
import {
  type MaterialAsset,
  ok,
  resolveMaterialAsset,
  selectMaterialStaticContract,
} from '@forgeax/engine-types';
import type { compileShader } from '../compile.js';
import { cookMaterialAsset, type MaterialCookedAsset, type MaterialCookRequest } from './cook.js';
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

/**
 * Pack owns fresh source bytes; GUIDs and uniform values remain per-publication data.
 * Keys include the complete source identity, so Packs with equal sources share
 * compiled variants even when other Packs cook in between, and concurrent Packs
 * asking for one variant wait for a single compilation. Retention stays bounded
 * by entry count and bytes across all identities.
 */
export function createMaterialPackVariantCompiler(compile: typeof compileShader) {
  type Retained = {
    readonly asset: Pick<MaterialCookedAsset, 'passes' | 'layerPlan'>;
    readonly bytes: number;
  };
  const variants = new Map<string, Retained>();
  const compiling = new Map<string, Promise<void>>();
  let heldBytes = 0;
  const retain = (key: string, cooked: MaterialCookedAsset): void => {
    let asset: Pick<MaterialCookedAsset, 'passes' | 'layerPlan'>;
    let bytes: number;
    try {
      asset = structuredClone({ passes: cooked.passes, layerPlan: cooked.layerPlan });
      bytes = retainedBytes(asset);
    } catch {
      return;
    }
    if (bytes > MAX_RETAINED_BYTES) return;
    while (variants.size >= MAX_ENTRIES || heldBytes + bytes > MAX_RETAINED_BYTES) {
      const oldest = variants.keys().next().value;
      if (oldest === undefined) break;
      heldBytes -= variants.get(oldest)?.bytes ?? 0;
      variants.delete(oldest);
    }
    heldBytes -= variants.get(key)?.bytes ?? 0;
    variants.set(key, { asset, bytes });
    heldBytes += bytes;
  };
  return async (request: MaterialCookRequest, sourceIdentity: string | undefined) => {
    if (
      sourceIdentity === undefined ||
      !plainJson(request.table) ||
      !plainJson(request.context) ||
      (request.vertexColorAvailable !== undefined &&
        typeof request.vertexColorAvailable !== 'boolean')
    )
      return cookMaterialAsset(request, compile);
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
    if (key !== undefined) {
      // Another Pack is compiling this exact variant; share its result. A
      // failed or unretained compilation leaves this request to compile itself.
      const inFlight = compiling.get(key);
      if (inFlight !== undefined && !variants.has(key)) await inFlight;
      const previous = variants.get(key);
      if (previous !== undefined) {
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
    }
    let settle: (() => void) | undefined;
    const done =
      key === undefined
        ? undefined
        : new Promise<void>((resolve) => {
            settle = resolve;
          });
    if (key !== undefined && done !== undefined) compiling.set(key, done);
    try {
      const cooked = await cookMaterialAsset(request, compile);
      if (!cooked.ok || key === undefined) return cooked;
      if (!plainJson(request.table) || !plainJson(request.context)) return cooked;
      // Retain only what the request still describes after the awaited compile.
      const current = resolveMaterialAsset(request.material, request.table);
      const currentContract = current.ok ? contractKey(current.value.asset) : undefined;
      if (currentContract === undefined || keyFor(currentContract) !== key) return cooked;
      retain(key, cooked.value);
      return cooked;
    } finally {
      if (key !== undefined && compiling.get(key) === done) compiling.delete(key);
      settle?.();
    }
  };
}
