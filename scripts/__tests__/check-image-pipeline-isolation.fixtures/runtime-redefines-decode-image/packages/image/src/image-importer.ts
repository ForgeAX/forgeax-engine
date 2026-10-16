// Fixture build-time decoder holder. The a.2-pos conjunct requires the
// imageImporter to statically import parseImage (the disk decoder now lives
// on the producer side, not the runtime).

import { parseImage } from './parse-image.js';

export const imageImporter = { key: 'image', import: () => [parseImage] };
