import { assert, expect, it, vi } from 'vitest';
import { EMPTY_GPU_DRAW_SELECTION } from '../../gpu-driven/draw-selection';
import { MaterialResource } from '../../material-resource';
import { warnZeroLightStandard } from '../../record/frame-lighting';
import { summarizeGpuDrivenDraws } from '../../record/gpu-draw-receipts';
import { defaultMaterialSnapshot, type RenderableSnapshot } from '../../render-system-extract';
import { FrameProjection, RetainedFrameProjection, rasterRowsOf } from '../frame-list';
import { MeshFrame } from '../mesh-frame';
import type { RenderSceneSlot } from '../render-scene-types';
import { SceneRows } from '../scene-rows';

function fixture(count: number) {
  const rows = new SceneRows();
  const material = MaterialResource.from({
    ...defaultMaterialSnapshot(),
    materialShaderId: 'forgeax::default-unlit',
  });
  const pose = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
  const values = Array.from(
    { length: count },
    (_, entityKey): RenderableSnapshot => ({
      worldId: 0,
      entityKey,
      transform: { world: pose },
      material,
      materials: [material],
      materialBindingSources: ['engine-default'],
      ...(entityKey === 7 || entityKey === count - 1 ? {} : { authorVisible: false }),
    }),
  );
  rows.apply(
    values.map((snapshot) => ({
      kind: 'update',
      worldId: 0,
      entityKey: snapshot.entityKey,
      snapshot,
    })),
    [],
    true,
  );
  const frame = rows.capture();
  const project = vi.fn((record: RenderSceneSlot) => record.snapshot);
  const list = new RetainedFrameProjection(
    frame,
    project,
    rows.rowFacts(frame, new MeshFrame(), project),
  );
  return { rows, frame, list, values, project, material };
}

it('does not observe hidden matrices or materials when checking a fixed unlit frame', () => {
  const f = fixture(4096);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const state = { warnedZeroLightStandard: false };
    warnZeroLightStandard(state, f.list, undefined, 0);
    expect(state.warnedZeroLightStandard).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(f.project.mock.calls.map(([record]) => record.entityKey)).toEqual([7, 4095]);
  } finally {
    warn.mockRestore();
  }
});

it('counts actual residual draws without observing inactive retained rows', () => {
  const f = fixture(4096);
  const summary = summarizeGpuDrivenDraws(f.list, EMPTY_GPU_DRAW_SELECTION);
  expect(summary.totalDraws).toBe(2);
  expect(summary.cpuDraws).toBe(2);
  expect(summary.semanticDraws).toBe(2);
  expect(summary.blockedDraws).toBe(0);
  expect(f.project.mock.calls.map(([record]) => record.entityKey)).toEqual([7, 4095]);
});

it('keeps custom visibility projections and borrowed source changes live', () => {
  const f = fixture(128);
  const custom = new FrameProjection(f.list, (row) => ({ ...row, authorVisible: true }));
  expect(summarizeGpuDrivenDraws(custom, EMPTY_GPU_DRAW_SELECTION).totalDraws).toBe(128);
  expect(summarizeGpuDrivenDraws(f.values, EMPTY_GPU_DRAW_SELECTION).totalDraws).toBe(2);
  const first = f.values[0];
  assert(first);
  f.values[0] = { ...first, authorVisible: true };
  expect(summarizeGpuDrivenDraws(f.values, EMPTY_GPU_DRAW_SELECTION).totalDraws).toBe(3);
  expect(summarizeGpuDrivenDraws(f.list, EMPTY_GPU_DRAW_SELECTION).totalDraws).toBe(2);
});

it('keeps raster membership with old roots through visibility, instance count, removal and address reuse', () => {
  const f = fixture(128);
  const source = f.values[7];
  assert(source);
  const readCurrent = () => {
    const root = f.rows.capture();
    return new RetainedFrameProjection(
      root,
      (row) => row.snapshot,
      f.rows.rowFacts(root, new MeshFrame(), (row) => row.snapshot),
    );
  };
  for (let cycle = 0; cycle < 20; cycle++) {
    f.rows.apply(
      [{ kind: 'update', worldId: 0, entityKey: 7, snapshot: { ...source, authorVisible: false } }],
      [],
      true,
    );
    expect([...rasterRowsOf(readCurrent())].map((row) => row.entityKey)).toEqual([127]);
    f.rows.apply([{ kind: 'update', worldId: 0, entityKey: 7, snapshot: source }], [], true);
    expect([...rasterRowsOf(readCurrent())].map((row) => row.entityKey)).toEqual([7, 127]);
    expect([...rasterRowsOf(f.list)].map((row) => row.entityKey)).toEqual([7, 127]);
  }
  f.rows.apply(
    [
      {
        kind: 'update',
        worldId: 0,
        entityKey: 7,
        instances: {
          transforms: new Float32Array(0),
          instanceCount: 0,
          cacheKey: 1,
          archVersion: 0,
        },
      },
    ],
    [],
    true,
  );
  expect([...rasterRowsOf(readCurrent())].map((row) => row.entityKey)).toEqual([127]);
  f.rows.apply([{ kind: 'remove', worldId: 0, entityKey: 7 }], [], true);
  f.rows.apply(
    [{ kind: 'update', worldId: 0, entityKey: 999, snapshot: { ...source, entityKey: 999 } }],
    [],
    true,
  );
  expect([...rasterRowsOf(readCurrent())].map((row) => row.entityKey)).toEqual([999, 127]);
  expect([...rasterRowsOf(f.list)].map((row) => row.entityKey)).toEqual([7, 127]);
  f.rows.dispose();
  expect([...rasterRowsOf(readCurrent())]).toEqual([]);
});

it('observes material adoption and preserves the bounded warning latch in every host mode', () => {
  const f = fixture(128);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const state = { warnedZeroLightStandard: false };
    warnZeroLightStandard(state, f.list, undefined, 0);
    expect(state.warnedZeroLightStandard).toBe(false);
    f.material.adopt({
      ...defaultMaterialSnapshot(),
      materialShaderId: 'forgeax::default-standard-pbr',
    });
    warnZeroLightStandard(state, f.list, undefined, 0);
    expect(state.warnedZeroLightStandard).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    f.project.mockClear();
    warnZeroLightStandard(state, f.list, undefined, 0);
    expect(f.project).not.toHaveBeenCalled();
    vi.stubEnv('NODE_ENV', 'production');
    const productionState = { warnedZeroLightStandard: false };
    warnZeroLightStandard(productionState, f.list, undefined, 0);
    expect(productionState.warnedZeroLightStandard).toBe(true);
    expect(f.project).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
  } finally {
    warn.mockRestore();
    vi.unstubAllEnvs();
  }
});
