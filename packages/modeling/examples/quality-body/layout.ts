import { type Model, model } from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';
import { BODY, panels } from './body.ts';

/**
 * Right, from a patch layout: the same panels and blends declared as a layout
 * first (hood, fender and door primaries meeting at G0 creases on the shoulder and waist
 * lines, the door's lower side on the sill line), then built and checked by it.
 */
export function buildFromLayout(session: SessionFactory = () => model()): Model {
  const layout = session('layout');
  const { hood, fender, door, lines } = panels();
  layout.featureLine({ name: 'shoulder', curve: lines.shoulder, continuity: 'G0' });
  layout.featureLine({ name: 'waist', curve: lines.waist, continuity: 'G0' });
  layout.featureLine({ name: 'sill', curve: lines.sill });
  layout.patchLayout({
    name: 'c114',
    featureLines: ['shoulder', 'waist', 'sill'],
    patches: [
      { id: 'hood', role: 'primary', surface: hood, flip: true, sides: { v0: { free: true } } },
      { id: 'fender', role: 'primary', surface: fender, flip: true, sides: { v0: { to: 'hood:v1', continuity: 'G0', feature: 'shoulder' } } },
      {
        id: 'door',
        role: 'primary',
        surface: door,
        flip: true,
        sides: { v0: { to: 'fender:v1', continuity: 'G0', feature: 'waist' }, v1: { feature: 'sill' } },
      },
    ],
    blends: [
      { between: ['hood', 'fender'], radius: BODY.shoulderBlend, continuity: 'G2', name: 'shoulder-blend' },
      { between: ['fender', 'door'], radius: BODY.waistBlend, continuity: 'G2', name: 'waist-blend' },
    ],
  });
  layout.surface({ layout: 'c114', chord: 0.0005, nonPlanar: 'keep', spacing: 'even', tag: 'body' });
  layout.uv.project({ mode: 'box', scale: 1 });
  return layout;
}
