// Image and Pack error contracts plus AssetGuid identity.

// === Image importer error model SSOT ===
// ImageErrorDetailByCode owns the closed vocabulary and payload shapes. The
// envelope and runtime constructors are derived from it so `.code` and
// `.detail` stay correlated for consumers.

/** Closed code union, derived from the detail map below. */
interface ImageErrorDetailByCode {
  'image-decode-failed': {
    readonly reason: string;
    readonly path?: string;
  };
  'image-format-unsupported': {
    readonly actualMime: string;
    readonly path?: string;
    readonly formatColorSpaceConflict?: {
      readonly format: string;
      readonly colorSpace: 'srgb' | 'linear';
      readonly expected: 'srgb' | 'linear';
    };
  };
  'image-dimension-out-of-bounds': {
    readonly requested: { readonly width: number; readonly height: number };
    readonly limit: number;
  };
  'image-meta-missing': {
    readonly sourcePath: string;
    readonly expectedSidecarPath: string;
  };
  'image-hdr-decode-failed': {
    readonly reason: string;
    readonly path?: string;
  };
  'atlas-empty-input': {
    readonly receivedCount: number;
  };
  'atlas-size-exceeded': {
    readonly name: string;
    readonly width: number;
    readonly height: number;
    readonly maxAtlasSize: number;
  };
  'atlas-region-mismatch': {
    readonly name: string;
    readonly regionsTotalPixels: number;
    readonly atlasPixels: number;
  };
  /** Programmatic RGBA8 authoring failure projected through ImageError. */
  'image-surface-invalid': {
    readonly operation:
      | 'create'
      | 'set-pixel'
      | 'fill-rect'
      | 'fill-circle'
      | 'blit'
      | 'noise'
      | 'to-asset';
    readonly field: string;
    readonly value: string | number;
    readonly expected: string;
  };
}

export type ImageErrorCode = keyof ImageErrorDetailByCode;

/** Detail union projected from one code-to-payload map. */
export type ImageErrorDetailFor<C extends ImageErrorCode> = Readonly<{ code: C }> &
  ImageErrorDetailByCode[C];

export type ImageErrorDetail = {
  [C in ImageErrorCode]: ImageErrorDetailFor<C>;
}[ImageErrorCode];

/**
 * Correlated error envelope. `ImageErrorFor<C>` is the producer-facing
 * generic; `ImageError` is its closed union for exhaustive consumer switches.
 */
export type ImageErrorFor<C extends ImageErrorCode> = Error & {
  readonly code: C;
  readonly expected: string;
  readonly hint: string;
  readonly detail: ImageErrorDetailFor<C>;
};

export type ImageError = {
  [C in ImageErrorCode]: ImageErrorFor<C>;
}[ImageErrorCode];

/**
 * Per-code `.hint` string literals SSOT (plan-strategy section 2.3 / Tier 2
 * documentation). `Record<ImageErrorCode, string>` ensures compile-time
 * completeness; any future minor add to `ImageErrorCode` raises a TS error
 * on this map until the matching hint is supplied (charter proposition 4
 * explicit failure -- producer/consumer + reviewer all see the missing arm).
 *
 * Each hint embeds an executable command so AI users self-recover by
 * copy-pasting the hint into the shell (plan-strategy Tier 2 "hint must
 * carry forgeax asset import import <path>" or similar; the image
 * plugin bin lands in feat-future-console-plugin-image — until then the
 * hint references the in-package importer surface).
 */
export const IMAGE_ERROR_HINTS: Readonly<Record<ImageErrorCode, string>> = {
  'image-decode-failed':
    'check file integrity; re-export from DCC tool (Photoshop / GIMP / Aseprite); dimensions > 0 + valid PNG / JPG header bytes',
  'image-format-unsupported':
    'supports PNG / JPG / TGA true-color sources; convert unsupported formats with: magick convert <input> <output>.png; check importSettings.colorSpace consistency with format family if formatColorSpaceConflict present',
  'image-dimension-out-of-bounds':
    'downscale source under device caps (typical maxTextureDimension2D = 8192 / 16384); use mipmap chain instead of larger source if lod is the goal',
  'image-meta-missing': 'run: forgeax asset import <path> --root <project> --json',
  'image-hdr-decode-failed':
    'check .hdr file integrity; verify Radiance RGBE header magic (#?RADIANCE) and FORMAT=32-bit_rle_rgbe header field; ensure file was not truncated',
  // feat-20260521-sprite-atlas-animation M1 T-02 — atlas hook hint strings
  // (plan-strategy section 2 D-2). Each hint embeds an executable recovery
  // path so AI users self-repair by copy-pasting the hint into the shell
  // or into the build config (charter P3 explicit failure + AGENTS.md
  // Error model "hint must carry executable recovery").
  'atlas-empty-input':
    'verify forgeax asset atlas --input <glob> --name <prefix> --output <dir> --root <project> matches at least 1 PNG on disk; run `ls <glob>` to inspect the resolved file set; add the missing sprite source or fix the glob pattern',
  'atlas-size-exceeded':
    'downscale the source PNG so width * height <= maxAtlasSize^2 (default 4096); or split sprites across multiple atlas runs (forgeax asset atlas --input <subset-glob> --name <other-prefix> --output <dir> --root <project>); or raise the cap via --max-atlas-size 8192 if device caps allow it',
  'atlas-region-mismatch':
    'shelfPack returned regions exceeding atlas footprint — packer safety net; file a forgeax-engine bug; rerun forgeax asset atlas with a smaller input set or lower --max-atlas-size as temporary recovery',
  'image-surface-invalid':
    'repair the PixelSurface authoring input named in err.detail; use positive integer dimensions, finite RGBA8 values, and a finite noise seed, then rerun the image producer',
};

/**
 * Image color-space discriminator (plan-strategy section 2.5 D Open Q-4 (c)).
 *
 * `'srgb'` -- baseColor / albedo authored in sRGB display space; uploaded
 * with `format='*-srgb'` so hardware applies the gamma decode automatically
 * (research F-3 spec guarantee for mipmap blits).
 *
 * `'linear'` -- normal / metallic / roughness / data textures authored in
 * linear color space; uploaded with `format='*-unorm'` (no gamma transform).
 */
export type ImageColorSpace = 'srgb' | 'linear';

/**
 * Image importer settings POD (plan-strategy section 2.2 D-4 image disk
 * schema; AC-26). 5-field free-form object persisted into the `*.meta.json`
 * `importSettings` field; the GUID lives at the top of the POD so consumers
 * (importer + runtime + console asset import) share one schema (charter
 * proposition 5 consistent abstraction).
 *
 * Fields:
 * - `guid` -- string-form RFC 4122 dash-form UUID identifying the single
 *   image sub-asset (image disk schema is currently single-sub-asset by
 *   design; cubemap face / array layer reserved for future feat).
 * - `colorSpace` -- `'srgb' | 'linear'` (drives uploadTexture format
 *   selection; plan-strategy section 2.5).
 * - `mipmap` -- `'auto' | 'none'` (`'auto'` enables runtime mipmap-generator
 *   blit chain; `'none'` ships a single mip level).
 * - `addressMode` -- WGPU address mode for sampler (passed through to
 *   uploadTexture's sampler descriptor).
 * - `filterMode` -- magFilter / minFilter selector.
 *
 * The shape stays free-form `Record<string, unknown>` compatible at the
 * `*.meta.json` `importSettings` slot (research F-9 -- meta.schema.json
 * does not lock importSettings sub-shape; minor add of new fields is
 * non-breaking; plan-strategy R5 risk-free).
 */
export interface ImageMeta {
  readonly guid: string;
  readonly colorSpace: ImageColorSpace;
  readonly mipmap: 'auto' | 'none';
  readonly addressMode: 'repeat' | 'clamp-to-edge' | 'mirror-repeat';
  readonly filterMode: 'nearest' | 'linear';
  /** Optional asset-owned cooked-payload target dimension. */
  readonly downscaleMaxDimension?: number;
}

/**
 * Decoded image POD (plan-strategy section 2.2 + section 3.3; AC-26).
 * Producer: `@forgeax/engine-image` parseImage / decodeImageFromFile.
 * Consumer: `@forgeax/engine-runtime` AssetRegistry.uploadTexture (M3).
 *
 * Six-field tight-packed shape:
 * - `bytes` -- decoded pixel buffer (RGBA tight-packed; 4 bytes per pixel).
 *   Producer guarantees `bytes.length === width * height * 4`.
 * - `width` / `height` -- pixel dimensions (must satisfy device caps
 *   `maxTextureDimension2D` floor; surfaced as `image-dimension-out-of-bounds`
 *   when exceeded).
 * - `mime` -- discriminator over the supported set (`'image/jpeg' | 'image/png' | 'image/x-tga'`);
 *   keeps the runtime side from sniffing magic bytes.
 * - `colorSpace` -- carried over from `ImageMeta.colorSpace`; uploadTexture
 *   asserts `format <-> colorSpace` consistency at the GPU upload entry
 *   (plan-strategy section 2.5 D Open Q-4 (c)).
 * - `mipmap` -- boolean derived from `ImageMeta.mipmap === 'auto'`; the
 *   runtime mipmap-generator skips the blit chain when false.
 *
 * Math-free POD; no Float32Array / branded handle on this shape (charter
 * proposition 5 consistent abstraction with TextureAsset POD).
 */
export interface DecodedImage {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly mime: 'image/jpeg' | 'image/png' | 'image/x-tga';
  readonly colorSpace: ImageColorSpace;
  readonly mipmap: boolean;
}

// === AssetGuid — disk-layer GUID brand type (feat-20260513-guid-asset-package-system) ===========
//
// Type-only declaration. Implementation (parse / format / equals / random) lives in
// @forgeax/engine-pack/guid. The brand field is a phantom string literal that prevents
// accidental assignment from plain Uint8Array or string at compile time.

/** 16-byte UUID brand for disk-layer asset identification. RFC 4122 UUIDv7 wire form. */
export type AssetGuid = Uint8Array & { readonly __guidBrand: 'AssetGuid' };

// === PackErrorCode / PackErrorDetail — disk-layer error SSOT (feat-20260513-guid-asset-package-system w15) ===
//
// Decision anchors:
// - requirements §6.1 (13-member closed union literal set SSOT; widened from
//   the original 8 by feat-20260523-shader-template-instance-split (+1) and
//   feat-20260608-scene-nesting-ecs-fication M1 / w8 (+4))
// - requirements §6.2 AC-05/07 (per-code discriminated detail)
// - plan-strategy §D-5 (PackError 4-field surface + check-pack-error-detail-narrowed.mjs guard)
// - AGENTS.md §Error model (structurally parallel to AssetErrorCode / InspectorErrorCode)

/**
 * Closed PackErrorCode union — 14 members.
 * Used exclusively by the @forgeax/engine-pack scanner fail-fast chain.
 *
 * | code | trigger |
 * |:--|:--|
 * | `'pack-module-not-found'` | ScriptablePack runtime import cannot resolve from its original source |
 * | `'pack-malformed-meta'` | .meta.json fails ajv schema validation |
 * | `'pack-malformed-pack'` | .pack.json fails ajv schema validation |
 * | `'pack-guid-malformed'` | a GUID field is not a valid 36-char RFC 4122 dash-form string |
 * | `'pack-orphan-meta'` | .meta.json exists but the corresponding source file does not |
 * | `'pack-meta-missing'` | source file exists but no .meta.json (strict mode) |
 * | `'pack-guid-collision'` | two .pack.json files declare the same GUID |
 * | `'pack-cyclic-reference'` | asset refs[] (incl. mount.source) form a cycle |
 * | `'pack-subasset-index-out-of-range'` | subAsset.sourceIndex >= source count |
 * | `'payload-schema-mismatch'` | material payload fails materialShader / paramSchema schema |
 * | `'pack-mount-localid-overlap'` | mount memberFirst windows overlap or collide with entities[] |
 * | `'pack-mount-count-mismatch'` | mount memberCount disagrees with referenced child SceneAsset |
 * | `'pack-mount-override-localid-out-of-range'` | override.localId outside the mount's member window |
 * | `'pack-mount-override-unknown-field'` | override.comp / override.field unknown to the schema vocab |
 *
 * Membership history: 8 -> 9 added 'payload-schema-mismatch' (feat-20260523
 * shader-template-instance-split); 9 -> 13 adds the four mount-* codes
 * (feat-20260608-scene-nesting-ecs-fication M1 / w8, plan-strategy D-8 literals
 * locked); source resolution is intentionally local to each Meta sidecar so
 * there is no project-level path alias registry.
 */
export type PackErrorCode =
  | 'pack-module-not-found'
  | 'pack-malformed-meta'
  | 'pack-malformed-pack'
  | 'pack-guid-malformed'
  | 'pack-orphan-meta'
  | 'pack-meta-missing'
  | 'pack-guid-collision'
  | 'pack-cyclic-reference'
  | 'pack-subasset-index-out-of-range'
  // === 1 new code (feat-20260523-shader-template-instance-split M1-T02) ===
  | 'payload-schema-mismatch'
  // === 4 new codes (feat-20260608-scene-nesting-ecs-fication M1 / w8;
  // plan-strategy D-8 literals locked) ===
  | 'pack-mount-localid-overlap'
  | 'pack-mount-count-mismatch'
  | 'pack-mount-override-localid-out-of-range'
  | 'pack-mount-override-unknown-field';

/**
 * Discriminated detail union for PackError — narrowed per PackError.code.
 * AI users access `err.detail.<field>` directly after switch (err.code) narrows
 * the variant. Variants without an own `code` field are narrowed exclusively by
 * the top-level `PackError.code` discriminant (the legacy 7 variants below);
 * variants that carry a `code` field (`payload-schema-mismatch`, the evolved
 * `pack-cyclic-reference`, and the four mount-* additions) double-narrow via
 * `Extract<PackErrorDetail, { code: ... }>` at the type layer (R10).
 *
 * Structurally parallel to RhiErrorDetail / MetricErrorDetail.
 */
export type PackErrorDetail =
  | {
      readonly code: 'pack-module-not-found';
      readonly sourcePath: string;
      readonly specifier: string;
    }
  | {
      /** Absolute or relative path to the malformed .meta.json file. */
      readonly path: string;
      /** ajv validation errors produced by validateMeta(). */
      readonly ajvErrors: readonly { readonly instancePath: string; readonly message: string }[];
    }
  | {
      /** Absolute or relative path to the malformed .pack.json file. */
      readonly path: string;
      /** ajv validation errors produced by validatePack(). */
      readonly ajvErrors: readonly { readonly instancePath: string; readonly message: string }[];
      /**
       * Optional human-readable reason category. Set to a fixed literal for
       * the runtime instantiate-path SceneEntity field-name typo route:
       * `'unknown component field'` (requirements §AC-08(b)). Absent on
       * scanner-path ajv-validation failures (where the structural
       * ajvErrors[].message string already carries the diagnostic).
       */
      readonly reason?: string;
    }
  | {
      /** The raw string value that failed UUID validation. */
      readonly raw: string;
      /** Human-readable reason (e.g. 'expected 36-char RFC 4122 dash-form UUID'). */
      readonly reason: string;
    }
  | {
      /** Path of the .meta.json that has no corresponding source file. */
      readonly metaPath: string;
      /** Path that was expected to exist as a source file. */
      readonly expectedFile: string;
    }
  | {
      /** Path of the source file that has no accompanying .meta.json. */
      readonly filePath: string;
    }
  | {
      /** The two .pack.json paths that both declare the same GUID (tuple, always length 2). */
      readonly paths: readonly [string, string];
      /** The colliding GUID dash-form string. */
      readonly guid: string;
    }
  // === Evolved variant (feat-20260608-scene-nesting-ecs-fication M1 / w8;
  // plan-strategy R10): pack-cyclic-reference now carries `code` + `kind` so
  // the build-time scanner (kind: 'mount-asset', cycle: GUID list) and the
  // runtime ChildOf detector (kind: 'childof', cycle: LocalEntityId list) stay
  // narrowable from a single error code. ===
  | {
      readonly code: 'pack-cyclic-reference';
      /**
       * Cycle origin tag: 'childof' for runtime ChildOf relationship cycles
       * (LocalEntityId stringified), 'mount-asset' for build-time
       * SceneAsset.mounts[].source GUID cycles (D-1).
       */
      readonly kind: 'childof' | 'mount-asset';
      /** Cycle path as ordered identifier strings; first === last. */
      readonly cycle: readonly string[];
    }
  | {
      /** Path of the .meta.json declaring the out-of-range sourceIndex. */
      readonly metaPath: string;
      /** The declared sourceIndex value. */
      readonly sourceIndex: number;
      /** The maximum valid sourceIndex (exclusive upper bound = source count). */
      readonly max: number;
    }
  // === 1 new variant (feat-20260523-shader-template-instance-split M1-T02) ===
  | {
      /** Discriminated code for material payload schema mismatch. */
      readonly code: 'payload-schema-mismatch';
      /** GUID of the offending material asset. */
      readonly guid: string;
      /** ajv validation errors for the material payload. */
      readonly errors: readonly { readonly instancePath: string; readonly message: string }[];
    }
  // === 4 new variants (feat-20260608-scene-nesting-ecs-fication M1 / w8;
  // plan-strategy D-8 literals locked; AC-04 / AC-05 / AC-06 / AC-07) ===
  | {
      readonly code: 'pack-mount-localid-overlap';
      /** Overlapping LocalEntityId values (sorted ascending). */
      readonly overlapping: readonly number[];
      /**
       * Source labels for the conflicting windows. Each entry is a
       * human-readable origin string (`mount[<localId>]`,
       * `entities[<localId>]`, etc.) of length matching `overlapping[]`.
       */
      readonly sources: readonly string[];
    }
  | {
      readonly code: 'pack-mount-count-mismatch';
      /** localId of the offending mount within its parent SceneAsset. */
      readonly mountLocalId: number;
      /** memberCount declared on the mount. */
      readonly declared: number;
      /** Actual entities[].length resolved from the referenced child SceneAsset. */
      readonly actual: number;
    }
  | {
      readonly code: 'pack-mount-override-localid-out-of-range';
      /** override.localId that fell outside the mount's member window. */
      readonly overrideLocalId: number;
      /** localId of the parent mount. */
      readonly mountLocalId: number;
      /** memberCount of the parent mount (window upper bound, exclusive). */
      readonly memberCount: number;
    }
  | {
      readonly code: 'pack-mount-override-unknown-field';
      /** Component name on which the override was authored. */
      readonly comp: string;
      /** Unknown field name. */
      readonly field: string;
      /** localId of the parent mount carrying the override. */
      readonly mountLocalId: number;
    };

/**
 * Per-code .hint string literals SSOT.
 * Record<PackErrorCode, string> ensures compile-time completeness.
 */
export const PACK_ERROR_HINTS: Readonly<Record<PackErrorCode, string>> = {
  'pack-module-not-found':
    'correct the import relative to detail.sourcePath, or install the named package in the project, then rebuild',
  'pack-malformed-meta':
    'check guid is a valid RFC 4122 UUID; validate with: ajv validate -s schema/meta.schema.json -d <file>',
  'pack-malformed-pack':
    'check all asset guid and refs[] fields are 36-char dash-form UUIDs; validate with pack.schema.json',
  'pack-guid-malformed':
    'use AssetGuid.random() or a UUIDv7 generator; all GUID fields must be 36-char RFC 4122 dash-form',
  'pack-orphan-meta': 'remove the orphan .meta.json or add the missing source file next to it',
  'pack-meta-missing':
    'run forgeax asset list --root <project> --json to list source files without .meta.json',
  'pack-guid-collision':
    'run forgeax asset verify --root <project> --json to list all GUID collisions; each GUID must be globally unique',
  'pack-cyclic-reference':
    'run forgeax asset verify --root <project> --json to print the cycle path; break the cycle by removing a refs[] entry',
  'pack-subasset-index-out-of-range':
    'check subAssets[].sourceIndex does not exceed the actual sub-image count in the source file',
  // === 1 new hint (feat-20260523-shader-template-instance-split M1-T02) ===
  'payload-schema-mismatch':
    'material asset payload failed schema validation; check paramSchema entries all use valid types from MATERIAL_PARAM_TYPES and materialShader is a non-empty string',
  // === 4 new hints (feat-20260608-scene-nesting-ecs-fication M1 / w8;
  // plan-strategy D-8) ===
  'pack-mount-localid-overlap':
    'check parent SceneAsset.mounts[].memberFirst windows do not overlap with each other or with entities[].localId; rebuild mount sidecar after the child SceneAsset reimport',
  'pack-mount-count-mismatch':
    'mount.memberCount must equal the referenced child SceneAsset totalSlots (entities.length + sum(mounts[].memberCount) + mounts.length); rebuild mount sidecar via forgeax asset verify --root <project> --json after the child SceneAsset reimport',
  'pack-mount-override-localid-out-of-range':
    'override.localId must be in [0, mount.memberCount); shrink the override or extend memberCount to match the child SceneAsset',
  'pack-mount-override-unknown-field':
    'override.comp / override.field must match a defined component schema; check defineComponent registry or rebuild mount sidecar after the child SceneAsset reimport',
};
