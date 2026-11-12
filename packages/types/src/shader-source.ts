import { sha256 } from './sha256.js';

/** Immutable CPU source owner. Runtime text is retained without splitting or copying. */
export class ShaderSource {
  readonly length: number;
  readonly #fragments: readonly string[];
  #identity: string | undefined;

  /**
   * `publishedIdentity` is the build-time source digest of a manifest source whose
   * bytes were already verified against it (the DDC-key idea): identity is then
   * `published:<digest>` and the WGSL is never rehashed at runtime. Sources
   * without a published digest keep the content-hash identity.
   */
  constructor(fragments: readonly string[], publishedIdentity?: string) {
    if (!Array.isArray(fragments) || !fragments.every((fragment) => typeof fragment === 'string'))
      throw new Error('Shader source requires immutable text fragments');
    this.#fragments = Object.freeze([...fragments]);
    this.length = fragments.reduce((length, fragment) => length + fragment.length, 0);
    if (publishedIdentity !== undefined) this.#identity = `published:${publishedIdentity}`;
    Object.freeze(this);
  }

  /**
   * Text decoded from bytes whose SHA-256 the caller has just verified. `utf8Sha256`
   * must be the lowercase hex digest of the complete UTF-8 encoding of `text`: it is
   * exactly the content-hash identity, so the text is never hashed a second time.
   */
  static fromVerifiedUtf8(text: string, utf8Sha256: string): ShaderSource {
    const source = new ShaderSource([text]);
    source.#identity = utf8Sha256;
    return source;
  }

  /** True when identity comes from a verified build-time digest rather than a runtime hash. */
  get hasPublishedIdentity(): boolean {
    return this.#identity?.startsWith('published:') === true;
  }

  get identity(): string {
    // Hash on actual use, never while receiving an unused background library.
    // Hash complete UTF-8 text: producer fragments can split surrogate pairs.
    this.#identity ??= sha256(this.read());
    return this.#identity;
  }

  /**
   * Same text. Published and content-hash identities are different key domains, so a
   * published source and an unpublished copy of the same bytes compare by text.
   */
  sameText(other: ShaderSource): boolean {
    if (this.hasPublishedIdentity === other.hasPublishedIdentity)
      return this.identity === other.identity;
    return other.length === this.length && this.matches(other.read());
  }

  static is(value: unknown): value is ShaderSource {
    return value !== null && typeof value === 'object' && #fragments in value;
  }

  read(): string {
    return this.#fragments.join('');
  }

  /** Compare exact borrowed text without joining fragments or hashing. May scan all text. */
  matches(text: string): boolean {
    if (text.length !== this.length) return false;
    let offset = 0;
    for (const fragment of this.#fragments) {
      if (!text.startsWith(fragment, offset)) return false;
      offset += fragment.length;
    }
    return true;
  }

  descriptor(label?: string): { readonly code: string; readonly label?: string } {
    const source = this;
    const descriptor = Object.freeze({
      get code() {
        return source.read();
      },
      ...(label === undefined ? {} : { label }),
    });
    descriptorSources.set(descriptor, source);
    return descriptor;
  }
}

// Descriptor identity carries the admitted owner across the existing factory
// seam without adding author-controlled digest fields to native dictionaries.
const descriptorSources = new WeakMap<object, ShaderSource>();

export function shaderSourceForDescriptor(descriptor: object): ShaderSource | undefined {
  return descriptorSources.get(descriptor);
}

/** Preserve an admitted owner through the existing factory code/label seam. */
export function shaderSourceDescriptor(
  source: string | ShaderSource,
  label?: string,
): { readonly code: string; readonly label?: string } {
  return typeof source === 'string'
    ? { code: source, ...(label === undefined ? {} : { label }) }
    : source.descriptor(label);
}
