// Node-only image decoder shell for @forgeax/engine-image.
//
// Lazy-loads `upng-js` (PNG) and `jpeg-js` (JPEG) via dynamic imports so the
// browser bundle tree-shakes both decoders out of the ESM output (the
// browser path uses createImageBitmap instead). Migrated from the original
// packages/runtime/src/ home in feat-20260515-learn-render-getting-started
// M2 T-M2-02 (Open Q-3 option a; plan-strategy section 2.4) -- runtime now
// only consumes DecodedImage POD and never imports the decoders.
//
// The implementation surface is filled out by T-M2-05; this file is staged
// here in T-M2-02 so the migration touches a single owner directory and the
// runtime package never ships a half-migrated state.

/**
 * Local widening of the upng-js dynamic-import surface (the package ships
 * without a usable @types entry; the d.ts in image-decoders.d.ts only adds
 * the module declaration). Lists the two functions consumed by the Node
 * decoder path; widening here keeps the import site free of `as any` casts
 * (charter P3 explicit failure -- structural typing > escape hatches).
 */
export interface UpngModule {
  decode: (bytes: Uint8Array | ArrayBuffer) => {
    width: number;
    height: number;
    depth: number;
    ctype: number;
    data: Uint8Array;
    frames?: unknown[];
  };
  toRGBA8: (img: { width: number; height: number; data: Uint8Array }) => ArrayBuffer[];
}

/**
 * Local widening of the jpeg-js dynamic-import surface. Mirrors the subset
 * used by the Node decoder; jpeg-js has @types/jpeg-js but we keep a local
 * shape so the d.ts ambient declaration stays the SSOT for runtime resolution
 * (charter P5 producer / consumer split).
 */
export interface JpegModule {
  decode: (
    bytes: Uint8Array | ArrayBuffer,
    opts?: { useTArray?: boolean; formatAsRGBA?: boolean },
  ) => {
    width: number;
    height: number;
    data: Uint8Array;
  };
}

/**
 * Lazy-load the upng-js Node decoder module. Browser bundlers tree-shake
 * this dynamic import out when only the createImageBitmap path is reached
 * at runtime; tsup external keeps the package name from being inlined.
 */
export async function loadUpng(): Promise<UpngModule> {
  const mod = (await import('upng-js')) as { default?: UpngModule } & UpngModule;
  return (mod.default ?? mod) as UpngModule;
}

/**
 * Lazy-load the jpeg-js Node decoder module. Same tree-shake guarantee as
 * loadUpng -- browser bundles never reach this path.
 */
export async function loadJpeg(): Promise<JpegModule> {
  const mod = (await import('jpeg-js')) as { default?: JpegModule } & JpegModule;
  return (mod.default ?? mod) as JpegModule;
}
