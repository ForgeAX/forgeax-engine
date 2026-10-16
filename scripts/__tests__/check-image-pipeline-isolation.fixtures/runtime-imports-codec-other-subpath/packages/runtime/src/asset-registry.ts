// Boundary fixture (w27 path d): runtime statically imports from
// @forgeax/engine-codec/something-else — an invalid subpath that is neither
// the main entry nor the encode subpath. The Path (d) gate must NOT trigger
// (it only blocks the specific `.../encode` subpath). The gate should PASS
// (exit 0) for this case — the import is not matched by the encode-subpath
// regex, so path d does not fire.

import { someUnknownExport } from '@forgeax/engine-codec/something-else';

export function placeholder() {
  return someUnknownExport;
}
