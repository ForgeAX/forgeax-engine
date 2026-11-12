import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CAR } from '../proportions';
import { featureError, silhouetteIoU } from '../reference';
import { buildS2Body, INTAKE, ON_CAR, SPLITS } from '../s2-body';
import { bodyPoint, buildS3Car, LINES, TAIL } from '../s3-rough';
import { WAIST, waistPlane } from '../s6-exterior';

/** C-100 criterion 9: the car form matches the measured blueprint silhouettes (IoU >= 0.93 per view). */
const VIEWS = ['right', 'top', 'front', 'back'] as const;

describe.each([
  ['S2', buildS2Body],
  ['S3', () => buildS3Car()],
] as const)('C-100 %s against the blueprint', (stage, build) => {
  it('has a silhouette IoU of at least 0.93 in every view', { timeout: 300000 }, () => {
    const m = build();
    const ious = VIEWS.map((view) => [view, Number(silhouetteIoU([m], view).iou.toFixed(4))] as const);
    if (process.env.FORGEAX_IOU_OUT) writeFileSync(`${process.env.FORGEAX_IOU_OUT}/${stage}.json`, JSON.stringify(Object.fromEntries(ious)));
    for (const [view, iou] of ious) expect([view, iou >= 0.93]).toEqual([view, true]);
  });
});

/** C-100 criterion 9: the side feature lines within 1 % of the car height (the front and back outlines are in the S6a case table). */
describe('C-100 S6a feature lines against the blueprint', () => {
  const limit = CAR.height.value / 100;
  const along = (f: (z: number) => number, z0: number, z1: number) => Array.from({ length: 300 }, (_, k) => {
    const z = z0 + ((z1 - z0) * k) / 299;
    return bodyPoint(z, f(z), 1);
  });
  const lines: Record<string, () => readonly (readonly number[])[]> = {
    shoulder: () => along(LINES.shoulder, TAIL, SPLITS.deck),
    belt: () => along(LINES.belt, SPLITS.deck, SPLITS.doorFront),
    waist: () => {
      const { point, normal } = waistPlane();
      // The groove plane contains x: in the side view it is the line through `point` normal to (ny, nz).
      return Array.from({ length: 100 }, (_, k) => {
        const z = WAIST.from + ((WAIST.to - WAIST.from) * k) / 99;
        return [1, (point[1] as number) - ((normal[2] as number) * (z - (point[2] as number))) / (normal[1] as number), z];
      });
    },
    sideIntake: () => INTAKE.map(([z, y]) => [1, y, z]),
  };
  it.each(Object.keys(lines))('%s', (name) => {
    const e = featureError(name, (lines[name] as () => readonly (readonly number[])[])(), ON_CAR);
    if (process.env.FORGEAX_IOU_OUT) writeFileSync(`${process.env.FORGEAX_IOU_OUT}/feature-${name}.json`, JSON.stringify(e));
    expect([name, e.max <= limit]).toEqual([name, true]);
  });
});
