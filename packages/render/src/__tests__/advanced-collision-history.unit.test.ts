import { mat4 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import {
  type AdvancedCollisionSnapshot,
  advancedCollisionHistory,
} from '../water/advanced-collisions';
import { dispersiveSourceIdentity } from '../water/dispersive-ocean';

function snapshot(
  x: number,
  origin = 0,
  generation = 2,
  extent = 1,
  motionDiscontinuity = 0,
): AdvancedCollisionSnapshot & {
  readonly roster: readonly [AdvancedCollisionSnapshot['roster'][number]];
} {
  const transform = mat4.compose(mat4.create(), [x - origin, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
  return {
    originM: [origin, 0, 0],
    primitives: new Float32Array([
      ...mat4.invert(mat4.create(), transform),
      ...transform,
      2,
      extent,
      1,
      1,
      0,
      0,
      0,
      0,
    ]),
    sdfInstances: new Uint8Array(144),
    sdfFields: new Uint8Array(4),
    roster: [
      {
        entity: 1,
        bodyGeneration: generation,
        completedStep: 3,
        motionDiscontinuity,
        identity: {
          kind: 'native-collider',
          colliderId: 'native:1',
          generation: 4,
          elementIndex: 0,
        },
        representation: 'box',
      },
    ],
  };
}

describe('advanced rigid accepted-frame pose history', () => {
  const meshSource = (
    x: number,
    revision: number,
    contentRevision: number,
  ): AdvancedCollisionSnapshot => ({
    ...snapshot(x),
    roster: snapshot(x).roster.map((row) => ({
      ...row,
      representation: 'distance-field' as const,
      mesh: { handle: 7, revision, contentRevision },
    })),
  });

  it('preserves source identity across unrelated closure writes and detects actual mesh content changes', () => {
    const prior = meshSource(1, 10, 3),
      current = meshSource(2, 20, 3);
    expect(dispersiveSourceIdentity(current)).toBe(dispersiveSourceIdentity(prior));
    expect(dispersiveSourceIdentity(meshSource(2, 21, 4))).not.toBe(
      dispersiveSourceIdentity(prior),
    );
  });

  it('preserves native pose history across unrelated closure writes and reseeds changed mesh contents', () => {
    const prior = meshSource(1, 10, 3),
      current = meshSource(2, 20, 3);
    expect(advancedCollisionHistory(current, prior).primitives[28]).toBe(1);
    expect(advancedCollisionHistory(meshSource(2, 21, 4), prior).primitives[28]).toBe(2);
  });

  it('keeps equivalent paired primitive rosters continuous when iteration order changes', () => {
    const first = meshSource(1, 10, 3),
      second = meshSource(2, 11, 4);
    const forward = {
      ...first,
      primitives: new Float32Array([...first.primitives, ...second.primitives]),
      roster: [first.roster[0], { ...second.roster[0], entity: 2 }],
    } as AdvancedCollisionSnapshot;
    const reverse = {
      ...forward,
      primitives: new Float32Array([...second.primitives, ...first.primitives]),
      roster: [...forward.roster].reverse(),
    };
    expect(dispersiveSourceIdentity(reverse)).toBe(dispersiveSourceIdentity(forward));
  });

  it('never pairs identical native counters from different Physics owners', () => {
    const prior = { ...snapshot(1), nativeSourceIdentity: 1 };
    const current = { ...snapshot(2), nativeSourceIdentity: 2 };
    expect(advancedCollisionHistory(current, prior)).toBe(current);
  });
  it('seeds an explicit native teleport from current pose and resumes ordinary motion afterwards', () => {
    const previous = snapshot(20.5632515, 27.5),
      reset = snapshot(0, 8, 2, 1, 1);
    const teleported = advancedCollisionHistory(reset, previous);
    const currentToLocal = mat4.invert(mat4.create(), teleported.primitives.subarray(0, 16));
    const previousPose = teleported.primitives.subarray(16, 32);
    expect(previousPose[12]).toBe(currentToLocal[12]);
    expect((Number(currentToLocal[12]) - Number(previousPose[12])) / (1 / 15)).toBe(0);
    const sailed = advancedCollisionHistory(snapshot(0.4, 8, 2, 1, 1), reset);
    const sailedPose = mat4.invert(mat4.create(), sailed.primitives.subarray(0, 16));
    expect((Number(sailedPose[12]) - Number(sailed.primitives[28])) / (1 / 15)).toBeCloseTo(6, 4);
    expect(previous.primitives[28]).toBeCloseTo(20.5632515 - 27.5, 5);
  });

  it('projects previous and current native poses around the same simulation origin', () => {
    const base = 1_000_000_000;
    const previous = snapshot(base + 0.125, base),
      current = snapshot(base + 0.25, base + 0.375);
    const packed = advancedCollisionHistory(current, previous);
    expect(packed.primitives[12]).toBe(0.125);
    expect(packed.primitives[28]).toBe(-0.25);
    expect(current.primitives[28]).toBe(-0.125);
    expect(previous.primitives[28]).toBe(0.125);
  });

  it('seeds a first pose and generation, geometry or mesh-version replacements from current', () => {
    const previous = snapshot(1),
      current = snapshot(2);
    expect(advancedCollisionHistory(current, undefined)).toBe(current);
    expect(advancedCollisionHistory(snapshot(2, 0, 3), previous).primitives[28]).toBe(2);
    expect(advancedCollisionHistory(snapshot(2, 0, 2, 2), previous).primitives[28]).toBe(2);
    const meshVersion = (
      value: AdvancedCollisionSnapshot,
      revision: number,
    ): AdvancedCollisionSnapshot => ({
      ...value,
      roster: value.roster.map((row) => ({
        ...row,
        representation: 'distance-field',
        mesh: { handle: 7, revision },
      })),
    });
    expect(
      advancedCollisionHistory(meshVersion(current, 2), meshVersion(previous, 1)).primitives[28],
    ).toBe(2);
  });

  it('pairs by native identity independently of array order and drops retired shapes', () => {
    const first = snapshot(1),
      second = snapshot(7);
    const previous: AdvancedCollisionSnapshot = {
      ...first,
      primitives: new Float32Array([...first.primitives, ...second.primitives]),
      roster: [
        first.roster[0],
        {
          ...second.roster[0],
          entity: 9,
          identity: {
            kind: 'native-collider',
            colliderId: 'native:9',
            generation: 4,
            elementIndex: 0,
          },
        },
      ],
    };
    const current: ReturnType<typeof snapshot> = {
      ...snapshot(8),
      roster: [
        {
          ...second.roster[0],
          entity: 9,
          identity: {
            kind: 'native-collider',
            colliderId: 'native:9',
            generation: 4,
            elementIndex: 0,
          },
        },
      ],
    };
    const packed = advancedCollisionHistory(current, previous);
    expect(packed.roster).toHaveLength(1);
    expect(packed.primitives[28]).toBe(7);
    expect(
      advancedCollisionHistory(
        {
          ...current,
          roster: [
            {
              ...current.roster[0],
              identity: {
                kind: 'native-collider',
                colliderId: 'native:9',
                generation: 5,
                elementIndex: 0,
              },
            },
          ],
        },
        previous,
      ).primitives[28],
    ).toBe(8);
  });
});
