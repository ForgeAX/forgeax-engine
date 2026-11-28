/** Validated CPU descriptors for the fixed 1x TSR analysis layout. */
export const TSR_ANALYSIS_FORMATS = Object.freeze({
  // UE guide color space (GCS) history, written by the reject stage.
  guide: 'rgba16float',
  // Moire history stays FP16 so sustained NewTotalVariation never clips at 1.0 under 8-bit UNORM.
  moire: 'rgba16float',
  // UE PF_R8G8B8A8 history rejection: (rejection, disableClamp, decreaseValidity, bitMask/255).
  decision: 'rgba8unorm',
  // UE PF_R8 MeasureFlickeringLuma: pre-fog exposed GLuma in .r.
  opaque: 'rgba8unorm',
  // Dilated scene tuple (FP16 motion + log depth + reactivity) and RGBA8 edge/moving flags.
  dilated: 'rgba16float',
  dilateEdge: 'rgba8unorm',
  // (VelocityEdge, HistoryUncertainty) handed from analysis to rejection.
  decimate: 'rgba8unorm',
  // Standalone flicker luma diagnostic format.
  flickerLuma: 'rgba16float',
  // (4-bit encoded texel offset xy, NoiseFiltering) of UE spatial anti-aliasing.
  spatial: 'rgba8unorm',
} as const);

/**
 * TsrParams uniform: 64 bytes of frame state, the 16-byte depth model, the 16-byte flicker terms,
 * the two 64-byte clip-to-previous-clip matrices, the 16-byte projection Z terms, the 64-byte
 * clip-to-resurrection-clip matrix and the 16-byte resurrection word.
 */
export const TSR_PARAMS_BYTES = 320;

/** Two FP16 Guides and two FP16 Moire histories; excludes transient stages. */
export const TSR_ANALYSIS_HISTORY_BYTES_PER_PIXEL = 2 * (8 + 8);

// WebGPU accounts RGBA8 render targets at eight bytes, independently of
// their four-byte copy footprint. The widest fixed TSR MRT cohort (analysis) costs 32 bytes.
export const TSR_RASTER_ATTACHMENT_BYTES_PER_SAMPLE = 4 * 8;
