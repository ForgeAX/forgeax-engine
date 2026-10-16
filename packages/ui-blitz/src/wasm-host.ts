/** One immutable module per realm. Platform code supplies path-based native or
 * byte-based browser instantiation without replacing global WebAssembly. */
export interface UiWasmHost {
  readWasm(): Promise<Uint8Array>;
  instantiate(imports: Readonly<Record<string, Readonly<Record<string, unknown>>>>): Promise<{
    readonly instance: { readonly exports: Record<string, unknown> };
    readonly module?: unknown;
  }>;
}
