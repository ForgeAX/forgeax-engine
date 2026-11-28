import { type Drawing, type Model, model } from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';
import { LEG, type LegParameters, type LegSpec, legSpec } from './spec.ts';

/**
 * Specification as the single source: `spec.ts` owns the lengths and landmarks, the two
 * parts and the design drawing only read them. Nothing here states a length, so a changed
 * proportion needs one edit and `validate({ drawing })` proves the parts still follow it.
 */

/** The thigh: a box between the knee and hip landmarks, tagged `thigh`. */
export function thigh(m: Model, s: LegSpec): void {
  const { length, width } = s.thigh;
  m.box({ size: [width, length, width], center: [0, s.knee + length / 2, 0], tag: 'thigh' });
}

/** The shin: a box between the ankle and knee landmarks, tagged `shin`. */
export function shin(m: Model, s: LegSpec): void {
  const { length, width } = s.shin;
  m.box({ size: [width, length, width], center: [0, s.ankle + length / 2, 0], tag: 'shin' });
}

/**
 * The side view of the same spec: landmark points, the two segment lengths as dimensions and
 * the outline as a silhouette. Every value is read from the spec; `basis: 'derived'` says so.
 */
export function legDrawing(s: LegSpec): Drawing {
  const t = s.thigh.width / 2;
  const h = s.shin.width / 2;
  const point = (id: string, y: number) =>
    ({ id, view: 'side', role: 'package', kind: 'point', at: [0, y], basis: 'derived' }) as const;
  return {
    name: 'leg spec',
    sources: [{ title: 'spec.ts', note: 'landmarks and sizes derived from LegParameters' }],
    views: [{ id: 'side', ortho: 'right' }],
    items: [
      point('hip', s.hip),
      point('knee', s.knee),
      point('ankle', s.ankle),
      {
        id: 'thigh length',
        view: 'side',
        role: 'package',
        kind: 'dimension',
        measure: 'distance',
        refs: ['knee', 'hip'],
        value: s.thigh.length,
        basis: 'derived',
      },
      {
        id: 'shin length',
        view: 'side',
        role: 'package',
        kind: 'dimension',
        measure: 'distance',
        refs: ['ankle', 'knee'],
        value: s.shin.length,
        basis: 'derived',
      },
      {
        id: 'outline',
        view: 'side',
        role: 'silhouette',
        kind: 'curve',
        closed: true,
        curve: {
          kind: 'polyline',
          points: [
            [-h, s.ankle],
            [h, s.ankle],
            [h, s.knee],
            [t, s.knee],
            [t, s.hip],
            [-t, s.hip],
            [-t, s.knee],
            [-h, s.knee],
          ],
        },
        basis: 'derived',
      },
    ],
  };
}

export function buildLeg(
  p: LegParameters = LEG,
  session: SessionFactory = () => model(),
): Model {
  const s = legSpec(p);
  const m = session('spec-single-source');
  m.drawing(legDrawing(s));
  thigh(m, s);
  shin(m, s);
  m.uv.project({ mode: 'box', scale: 0.5 });
  return m;
}
