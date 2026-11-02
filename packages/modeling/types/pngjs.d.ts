// The Engine lockfile carries pngjs without @types/pngjs; this declares the subset
// the Dawn evidence tests use.
declare module 'pngjs' {
  export class PNG {
    constructor(options: { width: number; height: number });
    readonly width: number;
    readonly height: number;
    data: Uint8Array;
    static readonly sync: { write(png: PNG): Uint8Array; read(bytes: Uint8Array): PNG };
  }
}
