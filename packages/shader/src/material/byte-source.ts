import { copyRetainedZstdBytes, retainedZstdBytes } from '@forgeax/engine-codec';
import { type MaterialRasterSourceRecipe, ShaderSource } from '@forgeax/engine-types';
import type { Result, ShaderError } from '../errors.js';
import type { MaterialShaderProgram } from './program.js';

/**
 * A program's byte owner and content identity. Pack bytes have already passed
 * the container check. A source owner verifies rebuilt bytes before publishing.
 */
export interface MaterialByteSource {
  readonly digest: string;
  readonly recipe?: MaterialRasterSourceRecipe;
  bytes?: Uint8Array;
  readonly prepare?: () => Promise<Result<Uint8Array, ShaderError>>;
  pending?: Promise<Result<void, ShaderError>>;
  failure?: ShaderError;
  source?: ShaderSource;
  program?: MaterialShaderProgram;
}

/** One private copy at admission: the caller's buffer may be reused after it is handed over. */
export function ownMaterialByteSource(bytes: Uint8Array, digest: string): MaterialByteSource {
  const copy = new Uint8Array(bytes);
  copyRetainedZstdBytes(bytes, copy);
  const storage = retainedZstdBytes(copy);
  return storage === undefined
    ? { bytes: copy, digest }
    : {
        get bytes() {
          return storage.read();
        },
        digest,
      };
}

export function readMaterialByteSource(owner: MaterialByteSource): ShaderSource {
  if (owner.source !== undefined) return owner.source;
  const bytes = owner.bytes;
  if (bytes === undefined) throw new TypeError('Cannot read an unprepared material program');
  owner.source = decodedSource(bytes, owner.digest);
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
