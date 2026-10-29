import { sha256 } from './sha256.js';

/** Immutable CPU source owner. Complete text is borrowed, never memoized here. */
export class ShaderSource {
  readonly identity: string;
  readonly length: number;
  readonly #fragments: readonly string[];

  constructor(fragments: readonly string[]) {
    if (!Array.isArray(fragments) || !fragments.every((fragment) => typeof fragment === 'string'))
      throw new Error('Shader source requires immutable text fragments');
    this.#fragments = Object.freeze([...fragments]);
    this.length = fragments.reduce((length, fragment) => length + fragment.length, 0);
    // Hash complete UTF-8 text: surrogate pairs can cross fragment boundaries.
    this.identity = sha256(this.read());
    Object.freeze(this);
  }

  static is(value: unknown): value is ShaderSource {
    return value !== null && typeof value === 'object' && #fragments in value;
  }

  /** Owner-local compact fragments; the caller owns the source index lifetime. */
  static fromText(text: string, pool: Map<string, string>): ShaderSource {
    const fragments: string[] = [];
    for (const paragraph of text.split(/(?<=\n\n)/u)) {
      for (let offset = 0; offset < paragraph.length; offset += 16_384) {
        const fragment = paragraph.slice(offset, offset + 16_384);
        let owned = pool.get(fragment);
        if (owned === undefined) {
          // Force independent UTF-16 storage. V8 sliced strings must not keep
          // the complete imported/expanded body alive behind a small fragment.
          const units = new Uint16Array(fragment.length);
          for (let index = 0; index < fragment.length; index++)
            units[index] = fragment.charCodeAt(index);
          owned = String.fromCharCode(...units);
          pool.set(owned, owned);
        }
        fragments.push(owned);
      }
    }
    return new ShaderSource(fragments);
  }

  read(): string {
    return this.#fragments.join('');
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
