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
  const existing = retainedMaterialByteSource(bytes, digest);
  if (existing !== undefined) return existing;
  if (`sha256:${bytesToHex(sha256(bytes))}` !== digest) return undefined;
  return ownMaterialByteSource(bytes, digest);
}

/**
 * Establish the same digest evidence off the calling thread. While the returned
 * owner is held, retainMaterialByteSource admits these bytes by comparison alone.
 * Undefined leaves the decision to synchronous admission, which hashes as usual.
 */
export async function verifyMaterialByteSource(
  bytes: Uint8Array,
  digest: string,
): Promise<MaterialByteSource | undefined> {
  const existing = retainedMaterialByteSource(bytes, digest);
  if (existing !== undefined) return existing;
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) return undefined;
  let hash: ArrayBuffer;
  try {
    hash = await subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  } catch {
    return undefined;
  }
  if (`sha256:${bytesToHex(new Uint8Array(hash))}` !== digest) return undefined;
  return retainedMaterialByteSource(bytes, digest) ?? ownMaterialByteSource(bytes, digest);
}

function retainedMaterialByteSource(
  bytes: Uint8Array,
  digest: string,
): MaterialByteSource | undefined {
  const existing = sources.get(digest)?.deref();
  return existing !== undefined && equalMaterialArtifactBytes(existing.bytes, bytes)
    ? existing
    : undefined;
}

function ownMaterialByteSource(bytes: Uint8Array, digest: string): MaterialByteSource {
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
  owner.source = verifiedSource(snapshot, owner.digest);
  return owner.source;
}

const exactUtf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * A well-formed snapshot without a byte-order mark decodes to text whose UTF-8
 * encoding is exactly these bytes, so the digest just verified is already the
 * text's content identity. Any other snapshot keeps the hashed-on-use identity.
 */
function verifiedSource(snapshot: Uint8Array, digest: string): ShaderSource {
  if (!(snapshot[0] === 0xef && snapshot[1] === 0xbb && snapshot[2] === 0xbf)) {
    let text: string | undefined;
    try {
      text = exactUtf8.decode(snapshot);
    } catch {
      text = undefined;
    }
    if (text !== undefined)
      return ShaderSource.fromVerifiedUtf8(text, digest.slice('sha256:'.length));
  }
  return new ShaderSource([new TextDecoder().decode(snapshot)]);
}
