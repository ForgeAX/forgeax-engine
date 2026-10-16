// Negative fixture (w7 case a): runtime re-implements the disk-decode
// symbol. The Path (a) gate must FAIL with a forbidden-implementation-symbol
// error -- regardless of whether the file also imports the legitimate
// public symbol from @forgeax/engine-image.

import type { DecodedImage } from '@forgeax/engine-types';

export function decodeImage(_buf: Uint8Array): DecodedImage {
  // Pretend implementation re-decoding bytes here.
  throw new Error('not implemented');
}
