import { sha256 } from './sha256.js';

/** Immutable CPU source owner. Runtime text is retained without splitting or copying. */
export class ShaderSource {
  readonly length: number;
  readonly #fragments: readonly string[];
  #identity: string | undefined;

  constructor(fragments: readonly string[]) {
    if (!Array.isArray(fragments) || !fragments.every((fragment) => typeof fragment === 'string'))
      throw new Error('Shader source requires immutable text fragments');
    this.#fragments = Object.freeze([...fragments]);
    this.length = fragments.reduce((length, fragment) => length + fragment.length, 0);
    Object.freeze(this);
  }

  get identity(): string {
    // Hash on actual use, never while receiving an unused background library.
    // Hash complete UTF-8 text: producer fragments can split surrogate pairs.
    this.#identity ??= sha256(this.read());
    return this.#identity;
  }

  static is(value: unknown): value is ShaderSource {
    return value !== null && typeof value === 'object' && #fragments in value;
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
