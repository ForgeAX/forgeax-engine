import { type Model, model } from '../../model';
import type { NurbsCurve, NurbsSurface } from '../../nurbs';
import data from './quality-body.json';

/**
 * C-114 car-body corner frozen at the `surface()` inputs: the hood, fender and door lofts
 * between the feature lines (right), and the noisy trace interpolated into one dense patch
 * (wrong).
 */
const surface = (s: unknown) => s as NurbsSurface;
const lines = data.lines as unknown as Readonly<Record<'shoulder' | 'waist' | 'sill', NurbsCurve>>;

function featureLines(m: Model): void {
  m.featureLine({ name: 'shoulder', curve: lines.shoulder, continuity: 'G0' });
  m.featureLine({ name: 'waist', curve: lines.waist, continuity: 'G0' });
  m.featureLine({ name: 'sill', curve: lines.sill });
}

export function buildRight(): Model {
  const body = model();
  featureLines(body);
  body.surface({
    patches: [
      { name: 'hood', surface: surface(data.hood), flip: true },
      { name: 'fender', surface: surface(data.fender), flip: true },
      { name: 'door', surface: surface(data.door), flip: true },
    ],
    blends: [
      { between: ['hood', 'fender'], radius: 0.005, continuity: 'G2', name: 'shoulder-blend' },
      { between: ['fender', 'door'], radius: 0.003, continuity: 'G2', name: 'waist-blend' },
    ],
    chord: 0.0005,
    nonPlanar: 'keep',
    spacing: 'even',
    tag: 'body',
  });
  body.uv.project({ mode: 'box', scale: 1 });
  return body;
}

export function buildWrong(): Model {
  const wrong = model();
  featureLines(wrong);
  wrong.surface({
    patches: [{ name: 'body', surface: surface(data.dense), flip: true }],
    chord: 0.0005,
    tag: 'body',
  });
  wrong.uv.project({ mode: 'box', scale: 1 });
  return wrong;
}
