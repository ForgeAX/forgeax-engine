import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { buildBlockout } from './blockout.ts';
import { G4_PARTS } from './details.ts';
import { G3_PARTS } from './forms.ts';

/** C-200 stage G4 (local parts): `mesh/maid-whale-g4`, G3 plus the detail parts. */
export function buildDetails() {
  return buildBlockout(withDetails());
}

/** G3 parts with the G4 replacements in place, followed by the new detail parts. */
export function withDetails() {
  const replaced = new Map(G4_PARTS);
  return [...G3_PARTS.map(([n, b]) => [n, replaced.get(n) ?? b] as const), ...G4_PARTS.filter(([n]) => !G3_PARTS.some(([g]) => g === n))];
}

export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c2004'),
  build: () => buildDetails().finish({ key: 'maid-whale-g4', normals: { mode: 'weighted' } }),
});
