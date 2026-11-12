import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { buildDressed } from './garments.ts';
import { buildHair } from './hair.ts';

/** C-200 stage G4 (hair grown from the scalp), worn over the G3 figure: `mesh/maid-whale-hair`. */
export function buildHairOnFigure() {
  const figure = buildDressed();
  const m = buildHair(figure);
  m.append(figure, { label: 'figure' });
  return m;
}

export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c2014'),
  build: () => buildHairOnFigure().finish({ key: 'maid-whale-hair', normals: { mode: 'weighted' } }),
});
