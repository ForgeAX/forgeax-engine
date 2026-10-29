import { ShaderSource } from '@forgeax/engine-types';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  equalMaterialArtifactBytes,
  type MaterialArtifactConflictError,
} from './artifact-registry.js';
import type { MaterialShaderProgram } from './program.js';

export interface MaterialByteSource {
  readonly bytes: Uint8Array;
  readonly digest: string;
  source?: ShaderSource;
  program?: MaterialShaderProgram;
}

// Content owners are shared across receiving registries, never their devices.
const sources = new Map<string, WeakRef<MaterialByteSource>>();
const cleanup = new FinalizationRegistry<{ key: string; ref: WeakRef<MaterialByteSource> }>(
  ({ key, ref }) => {
    if (sources.get(key) === ref) sources.delete(key);
  },
);

/** Retain read-only artifact bytes without another permanent byte copy or source string. */
export function retainMaterialByteSource(
  bytes: Uint8Array,
  digest: string,
): MaterialByteSource | undefined {
  const existing = sources.get(digest)?.deref();
  if (existing !== undefined && equalMaterialArtifactBytes(existing.bytes, bytes)) return existing;
  if (`sha256:${bytesToHex(sha256(bytes))}` !== digest) return undefined;
  const owner: MaterialByteSource = { bytes, digest };
  const ref = new WeakRef(owner);
  sources.set(digest, ref);
  cleanup.register(owner, { key: digest, ref });
  return owner;
}

export function readMaterialByteSource(
  owner: MaterialByteSource,
  identifier: string,
): ShaderSource {
  if (owner.source !== undefined) return owner.source;
  // Typed arrays are read-only by contract. Recheck a private snapshot before
  // decoding so later caller mutation can never become an admitted source.
  const snapshot = new Uint8Array(owner.bytes);
  if (`sha256:${bytesToHex(sha256(snapshot))}` !== owner.digest)
    throw Object.assign(
      new Error('ShaderRegistry: material program bytes changed after admission'),
      {
        code: 'material-artifact-conflict',
        expected: 'read-only program bytes matching their published digest',
        hint: 'reload the verified program and keep its retained bytes immutable',
        detail: { key: identifier, dimension: 'bytes' },
      } satisfies MaterialArtifactConflictError,
    );
  owner.source = new ShaderSource([new TextDecoder().decode(snapshot)]);
  return owner.source;
}
