import { ShaderSource } from '@forgeax/engine-types';
import type { MaterialShaderProgram } from './program.js';

/**
 * A program's bytes with the content digest its container check already
 * established. The digest is the identity; the registry never rehashes.
 */
export interface MaterialByteSource {
  readonly bytes: Uint8Array;
  readonly digest: string;
  source?: ShaderSource;
  program?: MaterialShaderProgram;
}

/** One private copy at admission: the caller's buffer may be reused after it is handed over. */
export function ownMaterialByteSource(bytes: Uint8Array, digest: string): MaterialByteSource {
  return { bytes: new Uint8Array(bytes), digest };
}

export function readMaterialByteSource(owner: MaterialByteSource): ShaderSource {
  owner.source ??= decodedSource(owner.bytes, owner.digest);
  return owner.source;
}

const exactUtf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * A well-formed text without a byte-order mark has UTF-8 bytes exactly these
 * bytes, so the digest is already the text's content identity. Any other
 * input keeps the hashed-on-use identity.
 */
function decodedSource(bytes: Uint8Array, digest: string): ShaderSource {
  if (!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) {
    let text: string | undefined;
    try {
      text = exactUtf8.decode(bytes);
    } catch {
      text = undefined;
    }
    if (text !== undefined)
      return ShaderSource.fromVerifiedUtf8(text, digest.slice('sha256:'.length));
  }
  return new ShaderSource([new TextDecoder().decode(bytes)]);
}
