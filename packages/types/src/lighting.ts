// @forgeax/engine-types - shared lighting asset facts.

/** Fixed azimuth samples in a cooked LM-63 Type C IES profile. */
export const IES_PROFILE_WIDTH = 256;
/** Fixed polar samples in a cooked LM-63 Type C IES profile. */
export const IES_PROFILE_HEIGHT = 128;
/** Bytes per little-endian float16 sample in a cooked IES profile. */
export const IES_PROFILE_BYTES_PER_SAMPLE = 2;
/** Minimum valid LightProbe radius in world units. */
export const R_MIN = 1e-4;

/** Build-time cooked LM-63 Type C photometric profile. */
export interface IesProfileAsset {
  readonly kind: 'ies-profile';
  /** 256 * 128 little-endian float16, linear, peak-normalized samples. */
  readonly data: Uint8Array;
}

/** Byte length required by one cooked IES profile. */
export const IES_PROFILE_BYTE_LENGTH =
  IES_PROFILE_WIDTH * IES_PROFILE_HEIGHT * IES_PROFILE_BYTES_PER_SAMPLE;
