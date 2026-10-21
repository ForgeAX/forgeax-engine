/**
 * Hand-authored TypeScript contracts for the two self-built basis_universal
 * WASM modules (see scripts/build-wasm.mjs). The .mjs/.wasm outputs are
 * gitignored (zero-binary, AC-12) and produced by embind, so no generated
 * .d.ts exists -- these interfaces are the typed surface M2 (transcoder glue)
 * and M3 (encoder glue) import against.
 *
 * Scope: only the API this Loop uses (ETC1S / UASTC-LDR / UASTC-HDR encode +
 * KTX2 transcode). ASTC-HDR-6x6 / PVRTC / DDS / .basis-file paths present in
 * the embind surface are intentionally not declared (OOS).
 *
 * Signatures mirror vendor/basis/webgl/transcoder/basis_wrappers.cpp
 * EMSCRIPTEN_BINDINGS(basis) at the pinned commit (D-2).
 */

/**
 * An embind `enum_<T>` value. Accessing `Module.enumName.MEMBER` yields one of
 * these; `.value` is the underlying integer passed back into WASM calls.
 */
export interface BasisEnumValue {
  readonly value: number;
}

/**
 * Transcode target formats (embind `transcoder_texture_format`). Only the
 * members this Loop's priority chain selects are named; the enum object carries
 * the full upstream set at runtime.
 */
export interface TranscoderTextureFormatEnum {
  readonly cTFBC1_RGB: BasisEnumValue;
  readonly cTFBC3_RGBA: BasisEnumValue;
  readonly cTFBC4_R: BasisEnumValue;
  readonly cTFBC5_RG: BasisEnumValue;
  readonly cTFBC7_RGBA: BasisEnumValue;
  readonly cTFBC6H: BasisEnumValue;
  readonly cTFETC1_RGB: BasisEnumValue;
  readonly cTFETC2_RGBA: BasisEnumValue;
  readonly cTFETC2_EAC_R11: BasisEnumValue;
  readonly cTFETC2_EAC_RG11: BasisEnumValue;
  readonly cTFASTC_4x4_RGBA: BasisEnumValue;
  readonly cTFASTC_HDR_4x4_RGBA: BasisEnumValue;
  readonly cTFRGBA32: BasisEnumValue;
  readonly cTFRGBA_HALF: BasisEnumValue;
}

/**
 * Source encode formats (embind `basis_tex_format`). Only the three delivery
 * encodings this Loop produces are named.
 */
export interface BasisTexFormatEnum {
  readonly cETC1S: BasisEnumValue;
  readonly cUASTC_LDR_4x4: BasisEnumValue;
  readonly cUASTC_HDR_4x4: BasisEnumValue;
}

/**
 * A KTX2 container opened for inspection + transcoding. Construct with the raw
 * container bytes; `close()` frees the WASM-side copy.
 */
export interface KTX2File {
  isValid(): boolean;
  close(): void;
  getWidth(): number;
  getHeight(): number;
  getLevels(): number;
  getLayers(): number;
  getFaces(): number;
  getBlockWidth(): number;
  getBlockHeight(): number;
  getHasAlpha(): number;
  /** DFD color model: 166 = UASTC-LDR/ETC1S, 167 = UASTC-HDR (D-3). */
  getDFDColorModel(): number;
  isSRGB(): boolean;
  isUASTC_LDR_4x4(): boolean;
  isETC1S(): boolean;
  isHDR(): boolean;
  isHDR4x4(): boolean;
  isLDR(): boolean;
  getBasisTexFormat(): number;
  /** width/height/blocks for one (level, layer, face). */
  getImageLevelInfo(level: number, layer: number, face: number): KTX2ImageLevelInfo;
  getImageTranscodedSizeInBytes(level: number, layer: number, face: number, format: number): number;
  /** Must be called once before any transcodeImage. Returns nonzero on success. */
  startTranscoding(): number;
  /**
   * Transcode one image into `dst`. Returns nonzero on success.
   * channel0/channel1 select source channels for R/RG targets (-1 = default).
   */
  transcodeImage(
    dst: Uint8Array,
    level: number,
    layer: number,
    face: number,
    format: number,
    getAlphaForOpaqueFormats: number,
    channel0: number,
    channel1: number,
  ): number;
}

export interface KTX2ImageLevelInfo {
  readonly origWidth: number;
  readonly origHeight: number;
  readonly width: number;
  readonly height: number;
  readonly numBlocksX: number;
  readonly numBlocksY: number;
}

export interface KTX2FileConstructor {
  new (data: Uint8Array): KTX2File;
}

/** A raw `.basis` source opened by the build-time BasisFile arm. */
export interface BasisFile {
  close(): void;
  getNumImages(): number;
  getNumLevels(imageIndex: number): number;
  getImageWidth(imageIndex: number, levelIndex: number): number;
  getImageHeight(imageIndex: number, levelIndex: number): number;
  getBasisTexFormat(): number;
  getHasAlpha(): number;
  startTranscoding(): number;
  getImageTranscodedSizeInBytes(imageIndex: number, levelIndex: number, format: number): number;
  transcodeImage(
    dst: Uint8Array,
    imageIndex: number,
    levelIndex: number,
    format: number,
    decodeFlags: number,
  ): number;
}

export interface BasisFileConstructor {
  new (data: Uint8Array): BasisFile;
}

/**
 * The transcoder WASM module (runtime-safe entry). Slim build: no encoder.
 */
export interface BasisTranscoderModule {
  /** Global one-time init; must run before constructing any KTX2File. */
  initializeBasis(): void;
  readonly transcoder_texture_format: TranscoderTextureFormatEnum;
  readonly basis_tex_format: BasisTexFormatEnum;
  readonly KTX2File: KTX2FileConstructor;
  readonly BasisFile?: BasisFileConstructor;
  /** Bytes per block (compressed) or per pixel (uncompressed) for a format. */
  getBytesPerBlockOrPixel(format: number): number;
}

/**
 * A one-shot texture encoder. `delete()` frees the WASM-side object.
 */
export interface BasisEncoder {
  /** img_type: 0 = raw RGBA bytes, 1 = PNG bytes. */
  setSliceSourceImage(
    sliceIndex: number,
    image: Uint8Array,
    width: number,
    height: number,
    imgType: number,
  ): boolean;
  /**
   * HDR source (RGBA float / half) for UASTC-HDR encode. `imgType` 0 =
   * cHITRGBAHalfFloat (rgba16float bytes), 1 = cHITRGBAFloat (rgba32float).
   * `ldrToHdrNitMultiplier` scales an upconverted LDR source (unused when the
   * source is already HDR; pass 1.0).
   */
  setSliceSourceImageHDR(
    sliceIndex: number,
    image: Uint8Array,
    width: number,
    height: number,
    imgType: number,
    ldrSrgbToLinear: boolean,
    ldrToHdrNitMultiplier: number,
  ): boolean;
  setFormatMode(texFormat: number): void;
  setCreateKTX2File(flag: boolean): void;
  setKTX2UASTCSupercompression(flag: boolean): void;
  /** Write the sRGB transfer function into the KTX2 header + DFD + basis file. */
  setKTX2AndBasisSRGBTransferFunc(flag: boolean): void;
  setPerceptual(flag: boolean): void;
  setMipGen(flag: boolean): void;
  setQualityLevel(quality: number): void;
  /**
   * ETC1S perf-vs-size effort level, range [0,6] (higher = slower / smaller).
   * Orthogonal to `setQualityLevel`; a lower value only trades file size for
   * encode speed (R-9 fast preset).
   */
  setETC1SCompressionLevel(compLevel: number): void;
  /**
   * UASTC-LDR pack flags; the low nibble is the pack level
   * `cPackUASTCLevelFastest`(0)..`cPackUASTCLevelVerySlow`(4) (R-9 fast preset).
   */
  setPackUASTCFlags(packFlags: number): void;
  /** UASTC-HDR search quality level, range [0,4] (higher = slower). */
  setUASTCHDRQualityLevel(level: number): void;
  /** Enable/disable threading; pass (false, 0) for deterministic single-thread encode. */
  controlThreading(enable: boolean, numExtraWorkerThreads: number): void;
  /** Encodes into `dst`; returns the byte length written (0 on failure). */
  encode(dst: Uint8Array): number;
  delete(): void;
}

export interface BasisEncoderConstructor {
  new (): BasisEncoder;
}

/**
 * The encoder WASM module (build-time entry; also carries the transcoder).
 */
export interface BasisEncoderModule {
  initializeBasis(): void;
  readonly basis_tex_format: BasisTexFormatEnum;
  readonly BasisEncoder: BasisEncoderConstructor;
  readonly KTX2File: KTX2FileConstructor;
}

/** The emscripten MODULARIZE factory default export of each .mjs glue module. */
export type BasisModuleFactory<TModule> = (overrides?: Record<string, unknown>) => Promise<TModule>;

/** Instantiate the published transcoder with the complete imports its factory supplies. */
export interface BasisWasmHost {
  /** Decoded bytes from the same immutable path used by instantiate. */
  readWasm(): Promise<Uint8Array>;
  instantiate(imports: Readonly<Record<string, Readonly<Record<string, unknown>>>>): Promise<{
    readonly instance: { readonly exports: Record<string, unknown> };
    readonly module?: unknown;
  }>;
}
