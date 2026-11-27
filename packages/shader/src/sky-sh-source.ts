import projection from './sky-sh.wgsl?raw';
import polynomial from './sky-sh-polynomial.wgsl?raw';

export const SKY_SH_WGSL = polynomial.slice(polynomial.indexOf('\n') + 1) + projection;
