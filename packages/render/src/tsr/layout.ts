/** Validated CPU descriptors for the fixed 1x TSR analysis layout. */
export const TSR_ANALYSIS_FORMATS = Object.freeze({
  guide: 'rgba8unorm',
  moire: 'rgba16float',
  decision: 'rgba16float',
  opaque: 'rgba16float',
} as const);

/** Two RGBA8 Guides and two FP16 Moire histories; excludes transient stages. */
export const TSR_ANALYSIS_HISTORY_BYTES_PER_PIXEL = 2 * (4 + 8);

// WebGPU accounts RGBA8 render targets at eight bytes, independently of
// their four-byte copy footprint. Both fixed TSR MRT cohorts cost 24 bytes.
export const TSR_RASTER_ATTACHMENT_BYTES_PER_SAMPLE = 3 * 8;
