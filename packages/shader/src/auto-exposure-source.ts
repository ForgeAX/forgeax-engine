import common from './auto-exposure-common.wgsl?raw';
import fragment from './auto-exposure-fragment.wgsl?raw';
import compute from './auto-exposure-meter.wgsl?raw';

/** Build embeds package-owned WGSL files without runtime file loading or a compiler dependency. */
export const AUTO_EXPOSURE_METER_WGSL = `${common}\n${compute}`;
export const AUTO_EXPOSURE_FRAGMENT_WGSL = `${common}\n${fragment}`;
