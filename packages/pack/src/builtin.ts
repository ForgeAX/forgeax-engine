import type { AssetGuid } from './guid.js';
import { AssetGuid as AssetGuidNS } from './guid.js';
import { uuidV5 } from './uuid-v5.js';

/**
 * ForgeaX engine namespace UUID for UUIDv5 derivation.
 * Value: 9a09805a-7623-482e-b322-9fc3591f2a38
 * This is a custom namespace; it is intentionally NOT the RFC 4122 X.500 namespace.
 */
const _nsResult = AssetGuidNS.parse('9a09805a-7623-482e-b322-9fc3591f2a38');
if (!_nsResult.ok) throw new Error('builtin: FORGEAX_NAMESPACE is not a valid UUID');
export const FORGEAX_NAMESPACE: AssetGuid = _nsResult.value;

/**
 * Derive a stable UUIDv5 AssetGuid from a name within the ForgeaX namespace.
 * Synchronous SHA-1 keeps builtin imports usable in default IIFE Workers.
 * Names retain their exact UTF-8 bytes and are not Pack source keys.
 */
export function deriveBuiltin(name: string): AssetGuid {
  return uuidV5(FORGEAX_NAMESPACE, name) as AssetGuid;
}

function deriveString(name: string): string {
  return AssetGuidNS.format(deriveBuiltin(name));
}

/**
 * Stable module constant for the HANDLE_CUBE builtin GUID.
 * Derived from: deriveBuiltin('HANDLE_CUBE') under FORGEAX_NAMESPACE.
 */
export const BUILTIN_HANDLE_CUBE = deriveString('HANDLE_CUBE');

/**
 * Stable module constant for the HANDLE_TRIANGLE builtin GUID.
 * Derived from: deriveBuiltin('HANDLE_TRIANGLE') under FORGEAX_NAMESPACE.
 */
export const BUILTIN_HANDLE_TRIANGLE = deriveString('HANDLE_TRIANGLE');

/**
 * Stable module constant for the HANDLE_QUAD builtin GUID.
 * Derived from: deriveBuiltin('HANDLE_QUAD') under FORGEAX_NAMESPACE.
 */
export const BUILTIN_HANDLE_QUAD = deriveString('HANDLE_QUAD');

/** Stable UUIDv5 for the Engine-owned sphere mesh descriptor. */
export const BUILTIN_HANDLE_SPHERE = deriveString('HANDLE_SPHERE');

/** Stable UUIDv5 for the Engine-owned nine-slice quad descriptor. */
export const BUILTIN_HANDLE_NINESLICE_QUAD = deriveString('HANDLE_NINESLICE_QUAD');

/** Stable UUIDv5 for the Engine-owned cylinder mesh descriptor. */
export const BUILTIN_HANDLE_CYLINDER = deriveString('HANDLE_CYLINDER');

export type BuiltinMeshGeometry =
  | 'procedural-cube'
  | 'procedural-triangle'
  | 'procedural-quad'
  | 'procedural-sphere'
  | 'procedural-nine-slice-quad'
  | 'procedural-cylinder';

/**
 * The complete Engine-owned procedural mesh catalog.
 *
 * These are Pack descriptors, not runtime payloads: the Geometry decoder
 * expands each `geometry` token into its validated MeshAsset. DevKit uses this
 * list to materialize only the descriptors a standalone project does not
 * already author, keeping the shipped game self-contained without duplicate
 * GUID declarations.
 */
export const BUILTIN_MESH_ASSETS: ReadonlyArray<{
  readonly guid: string;
  readonly geometry: BuiltinMeshGeometry;
}> = Object.freeze([
  { guid: BUILTIN_HANDLE_CUBE, geometry: 'procedural-cube' },
  { guid: BUILTIN_HANDLE_TRIANGLE, geometry: 'procedural-triangle' },
  { guid: BUILTIN_HANDLE_QUAD, geometry: 'procedural-quad' },
  { guid: BUILTIN_HANDLE_SPHERE, geometry: 'procedural-sphere' },
  { guid: BUILTIN_HANDLE_NINESLICE_QUAD, geometry: 'procedural-nine-slice-quad' },
  { guid: BUILTIN_HANDLE_CYLINDER, geometry: 'procedural-cylinder' },
]);
