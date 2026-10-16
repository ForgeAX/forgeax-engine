/**
 * Hosts read and instantiate the same immutable published physics module.
 * Path-based hosts bind both operations to one package path; the loader verifies
 * its bytes before instantiation and adopts one module per realm.
 */
export interface PhysicsWasmHost {
  /** Monotonic, finite, nonnegative milliseconds; independent of World fixed delta. */
  now(): number;
  readWasm(): Promise<Uint8Array>;
  instantiate(imports: Readonly<Record<string, Readonly<Record<string, unknown>>>>): Promise<{
    readonly instance: { readonly exports: Record<string, unknown> };
    readonly module?: unknown;
  }>;
}
