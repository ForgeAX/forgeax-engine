import { assert, expect, it } from 'vitest';
import { FieldEditState, fieldEditOwnerKey, fieldEditState } from '../../raytracing/field-edit';
import { deriveFieldReceivers, fieldReceiverPoseMatches } from '../../raytracing/field-receiver';
import { packGlobalSdfComposition } from '../../raytracing/global-sdf';
import { projectVisibleSurfaces } from '../../raytracing/visible-surface';
import type { RenderableSnapshot } from '../../render-system-extract';
import { receiverMetadataFixture } from './field-receiver.fixture';
import { probeGlobalProfile } from './probe-global.fixture';

// Preserved pre-optimization predicate, independent raw-word comparison.
function copiedPoseReference(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== 16 || b.length !== 16) return false;
  const left = Float32Array.from(a),
    right = Float32Array.from(b);
  if (!left.every(Number.isFinite) || !right.every(Number.isFinite)) return false;
  const words = new Uint32Array(left.buffer),
    other = new Uint32Array(right.buffer);
  return words.every((word, index) => word === other[index]);
}

it('matches the preserved pose word predicate without temporary pose copies', () => {
  const base = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const controls: ArrayLike<number>[] = [base, base.subarray(0, 15), new Float32Array(17)];
  for (const scalar of [
    0,
    -0,
    Number.NaN,
    Infinity,
    -Infinity,
    Number.MAX_VALUE,
    1,
    1 + 2 ** -25,
    1 + 2 ** -23,
    2 ** -149,
    2 ** -150,
    -(2 ** -150),
  ]) {
    const value = Float64Array.from(base);
    value[12] = scalar;
    controls.push(value);
  }
  const rounded = Float64Array.from(base);
  rounded[0] = 1 + 2 ** -25;
  controls.push(rounded);
  for (const left of controls)
    for (const right of controls)
      expect(fieldReceiverPoseMatches(left, right)).toBe(copiedPoseReference(left, right));
  const negativeZero = base.slice();
  negativeZero[12] = -0;
  expect(fieldReceiverPoseMatches(base, negativeZero)).toBe(false);
  expect(fieldReceiverPoseMatches(base, rounded)).toBe(true);
});

it('keeps accepted identity separate from contact, epoch and raw primitive validity', async () => {
  const f = await receiverMetadataFixture();
  try {
    const ready = deriveFieldReceivers(f.input).unwrap();
    assert(ready.state === 'ready');
    expect(
      ready.resolve(1, 0, f.input.acceptedSource, f.input.owner.identity).unwrap(),
    ).toMatchObject({
      state: 'identified',
      canonicalRow: 0,
      primitive: 0,
      contact: { state: 'unavailable', reason: 'receiver-contact-unqualified' },
    });
    expect(ready.resolve(1, 0, [0, 0, 1, 2], f.input.owner.identity).unwrap().state).toBe(
      'unavailable',
    );
    expect(ready.resolve(1, 0xffffffff, f.input.acceptedSource, f.input.owner.identity).ok).toBe(
      false,
    );
    expect(ready.resolve(1, -1, f.input.acceptedSource, f.input.owner.identity).ok).toBe(false);
    expect(ready.resolve(0, 0, f.input.acceptedSource, f.input.owner.identity).unwrap().state).toBe(
      'unavailable',
    );
  } finally {
    f.dispose();
  }
});

it('closes missing ownership, tombstone, mask, pose, geometry and material metadata', async () => {
  const f = await receiverMetadataFixture();
  try {
    const moved = f.pose.slice();
    moved[12] = 1;
    const cases = [
      { state: new FieldEditState() },
      { placement: { ...f.input.placement, instances: [{ ...f.instance, mask: 0 }] } },
      {
        placement: {
          ...f.input.placement,
          instances: [{ ...f.instance, surfaceCoverage: 'unavailable' as const }],
        },
      },
      { placement: { ...f.input.placement, instances: [{ ...f.instance, transform: moved }] } },
      { sources: [{ ...f.source, assetRevision: 4 }] },
      { sources: [{ ...f.source, materials: [] }] },
      { sources: [] },
    ];
    for (const control of cases) {
      const frame = deriveFieldReceivers({ ...f.input, ...control }).unwrap();
      assert(frame.state === 'ready');
      expect(
        frame.resolve(1, 0, f.input.acceptedSource, f.input.owner.identity).unwrap().state,
      ).toBe('unavailable');
    }
    expect(deriveFieldReceivers({ ...f.input, acceptedSource: [0, 0, 1, 2] }).unwrap().state).toBe(
      'unavailable',
    );
  } finally {
    f.dispose();
  }
});

it('rejects ambiguous explicit generations instead of aliasing the last owned row', async () => {
  const f = await receiverMetadataFixture();
  try {
    const instances = { instanceCount: 2, cacheKey: 1, archVersion: 0 };
    for (const generations of [undefined, new Uint32Array([11, 11]), new Uint32Array([11, 0])]) {
      const result = deriveFieldReceivers({
        ...f.input,
        sources: [
          {
            ...f.source,
            transforms: [f.pose, f.pose],
            instances: {
              ...instances,
              ...(generations === undefined ? {} : { generations }),
            },
          },
        ],
      });
      expect(result.ok).toBe(false);
    }
    expect(fieldEditOwnerKey(f.source.record, 11)).not.toBe(fieldEditOwnerKey(f.source.record, 22));
  } finally {
    f.dispose();
  }
});

it('leaves deformed and LOD pixels uncovered through the actual projection API', async () => {
  const f = await receiverMetadataFixture();
  try {
    const controls: Partial<RenderableSnapshot>[] = [
      { morph: { weights: new Float32Array([1]), targetCount: 1 } },
      { lods: [{ mesh: f.meshHandle, screenCoverage: 0.5 }] },
    ];
    for (const control of controls) {
      f.scene.apply([{ kind: 'update', entityKey: 41, snapshot: { ...f.renderable, ...control } }]);
      const raster = projectVisibleSurfaces(f.scene.slotsSnapshot(), 32).unwrap();
      expect(raster.entityBases.has(41)).toBe(false);
      const frame = deriveFieldReceivers({ ...f.input, raster, sources: [] }).unwrap();
      assert(frame.state === 'ready');
      expect(
        frame.resolve(0, 0, f.input.acceptedSource, f.input.owner.identity).unwrap().state,
      ).toBe('unavailable');
    }
  } finally {
    f.dispose();
  }
});

it('uses persistent instance generations when actual raster ordinals reorder', async () => {
  const f = await receiverMetadataFixture();
  try {
    const moved = f.pose.slice();
    moved[12] = 1;
    const metadata = {
      instanceCount: 2,
      cacheKey: 41,
      archVersion: 0,
      generations: new Uint32Array([11, 22]),
    };
    const instances = [f.instance, { ...f.instance, instanceId: 1, transform: moved }];
    const state = fieldEditState(
      [
        {
          ...f.source,
          ...f.source.record,
          instances: metadata,
          firstInstance: 0,
          fieldSnapshot: f.source.field,
        },
      ],
      instances,
    );
    const composition = packGlobalSdfComposition(instances, probeGlobalProfile.grid, {
      capacity: 2,
      index: false,
      sourceEpoch: 1,
    }).unwrap();
    const reordered = { ...metadata, generations: new Uint32Array([22, 11]) };
    f.scene.apply([
      {
        kind: 'update',
        entityKey: 41,
        snapshot: {
          ...f.renderable,
          instances: { ...reordered, transforms: Float32Array.from([...moved, ...f.pose]) },
        },
      },
    ]);
    const raster = projectVisibleSurfaces(f.scene.slotsSnapshot(), 32).unwrap();
    const expected = [
      composition.data.instances.byteLength / 4,
      composition.data.fields.byteLength / 4,
      2,
      1,
    ] as const;
    const frame = deriveFieldReceivers({
      ...f.input,
      raster,
      state,
      acceptedSource: expected,
      placement: {
        instances,
        instanceData: composition.data.instances,
        surface: composition.surface,
      },
      sources: [{ ...f.source, instances: reordered, transforms: [moved, f.pose] }],
    }).unwrap();
    assert(frame.state === 'ready');
    expect(frame.resolve(1, 0, expected, f.input.owner.identity).unwrap()).toMatchObject({
      state: 'identified',
      canonicalRow: 1,
      owner: { instanceGeneration: 22 },
    });
    expect(frame.resolve(2, 0, expected, f.input.owner.identity).unwrap()).toMatchObject({
      state: 'identified',
      canonicalRow: 0,
      owner: { instanceGeneration: 11 },
    });
  } finally {
    f.dispose();
  }
});
