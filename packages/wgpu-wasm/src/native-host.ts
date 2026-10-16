// Producer-derived modules live in consumer projects. Resolve their integrity
// primitive through the public SDK, which owns its bundled dependency closure.
export { sha256 } from '@noble/hashes/sha2.js';

/** Native objects remain in the current realm. Admission never changes their identity. */
export interface NativeWgpuCanvas {
  getContext(
    kind: 'webgl2',
    options?: Readonly<Record<string, unknown>>,
  ): {
    readonly VERSION: number;
    getParameter(parameter: number): unknown;
  } | null;
}

export type NativeWgpuImports = Readonly<Record<string, Readonly<Record<string, unknown>>>>;
export interface NativeWgpuInstance {
  readonly instance: { readonly exports: Record<string, unknown> };
  readonly module?: unknown;
}

/** The package path is supplied by the build owner; instantiate reads that same immutable file. */
export interface NativeWgpuHost {
  readonly surfaces: readonly NativeWgpuCanvas[];
  readWasm(): Promise<Uint8Array>;
  instantiate(imports: NativeWgpuImports): Promise<NativeWgpuInstance>;
}

/** Export implemented by the producer-derived binding, alongside the original raw classes. */
export interface NativeWgpuInitializer {
  initializeNativeWgpu(host: NativeWgpuHost): Promise<Record<string, unknown>>;
}
