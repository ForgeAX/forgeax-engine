import { describe, expect, it } from 'vitest';
import { inspectLodOcclusion } from '../scene/visibility/inspection';
import { resolveInspectionBuild } from './render-system-driver';

const row = {
  root: { guid: '018e7a4d-1234-7abc-8def-000000000002', sourceKey: 'assets/lod-scene.gltf' },
  view: { attachmentId: 'source-a', cameraEntity: 1, viewRole: 'main' as const, viewGeneration: 4 },
  slot: { primitiveSlot: 2, slotGeneration: 9 },
  generation: 10,
  count: { candidates: 2, visible: 1, occluded: 1 },
  lodHistogram: [{ level: 0, count: 2 }],
  samples: [{ primitiveSlot: 2, level: 0, visible: true }],
};

describe('LOD occlusion inspection lifecycle', () => {
  it('retains detached GPU-selector reasons separately from the LOD population', () => {
    const submit = { frameId: 12, build: 'test-build', deviceGeneration: 2 };
    const gpu = {
      candidateCount: 100,
      visible: 40,
      frustumCulled: 50,
      texelCulled: 2,
      cameraCulled: 0,
      overflow: false,
      geometryWork: 1440,
      rootGeometryWork: 2880,
      occlusion: { culled: 8, late: 3 },
    };
    const result = inspectLodOcclusion({
      ...row,
      submit,
      attribution: { status: 'same-submit', submit },
      gpu,
    });
    expect(result.count).toEqual(row.count);
    expect(result.gpu).toEqual(gpu);
    gpu.frustumCulled = 99;
    gpu.occlusion.culled = 99;
    expect(result.gpu?.frustumCulled).toBe(50);
    expect(result.gpu?.occlusion?.culled).toBe(8);
    expect(Object.isFrozen(result.gpu)).toBe(true);
    expect(Object.isFrozen(result.gpu?.occlusion)).toBe(true);
  });

  it('rejects GPU reasons without same-submit attribution or with invalid counters', () => {
    const submit = { frameId: 12, build: 'test-build', deviceGeneration: 2 };
    const gpu = {
      candidateCount: 4,
      visible: 2,
      frustumCulled: 1,
      texelCulled: 0,
      cameraCulled: 0,
      overflow: false,
      geometryWork: 72,
      rootGeometryWork: 72,
    };
    expect(() => inspectLodOcclusion({ ...row, submit, gpu })).toThrow('same-submit');
    for (const invalid of [
      { frustumCulled: -1 },
      { visible: NaN },
      { occlusion: { culled: 1, late: -1 } },
    ])
      expect(() =>
        inspectLodOcclusion({
          ...row,
          submit,
          attribution: { status: 'same-submit', submit },
          gpu: { ...gpu, ...invalid },
        }),
      ).toThrow('non-negative integer');
  });

  it('uses the build-tool revision for inspection submits', () => {
    expect(resolveInspectionBuild({ build: 'merge-ref-123' })).toBe('merge-ref-123');
    expect(resolveInspectionBuild({ build: undefined })).toBe('render-system');
  });

  it('publishes detached source facts for one submit', () => {
    const input = { ...row, submit: { frameId: 10, build: 'test-build', deviceGeneration: 2 } };
    const inspection = inspectLodOcclusion(input);

    expect(inspection.schema).toBe('forgeax::lod-occlusion-inspection::v4');
    expect(inspection.submit).toEqual(input.submit);
    expect(inspection.attribution).toEqual({
      status: 'unavailable',
      reason: 'projection-only',
    });
    expect(inspection.count).toEqual(row.count);
    expect(inspection.slot).toEqual(row.slot);
    input.count.visible = 99;
    const inputSample = input.samples[0];
    if (!inputSample) throw new Error('Expected an input sample');
    inputSample.level = 7;
    input.submit.frameId = 99;
    expect(inspection.count.visible).toBe(1);
    expect(inspection.samples[0]?.level).toBe(0);
    expect(inspection.submit.frameId).toBe(10);
    for (const value of [
      inspection,
      inspection.count,
      inspection.samples,
      inspection.samples[0],
      inspection.submit,
    ])
      expect(Object.isFrozen(value)).toBe(true);
    row.count.visible = 1;
    const rowSample = row.samples[0];
    if (!rowSample) throw new Error('Expected a row sample');
    rowSample.level = 0;
  });

  it('only accepts attribution with the parent submit identity', () => {
    const submit = { frameId: 12, build: 'test-build', deviceGeneration: 2 };
    const inspection = inspectLodOcclusion({
      ...row,
      submit,
      attribution: { status: 'same-submit', submit },
    });
    expect(inspection.attribution).toEqual({
      status: 'same-submit',
      submit,
    });
    for (const other of [
      { ...submit, frameId: 13 },
      { ...submit, build: 'other' },
      { ...submit, deviceGeneration: 3 },
    ]) {
      expect(() =>
        inspectLodOcclusion({
          ...row,
          submit,
          attribution: { status: 'same-submit', submit: other },
        }),
      ).toThrow('attribution must reference the parent inspection submit');
    }
  });

  it('retains a held source projection when a later source replaces it', () => {
    const submit = { frameId: 20, build: 'test-build', deviceGeneration: 3 };
    const first = inspectLodOcclusion({
      ...row,
      submit,
      attribution: { status: 'same-submit', submit },
    });
    const second = inspectLodOcclusion({
      ...row,
      view: { ...row.view, attachmentId: 'source-b' },
      slot: { primitiveSlot: 9, slotGeneration: 11 },
      submit: { ...submit, frameId: 21 },
    });
    expect(first.view.attachmentId).toBe('source-a');
    expect(first.slot).toEqual({ primitiveSlot: 2, slotGeneration: 9 });
    expect(first.attribution).toEqual({ status: 'same-submit', submit });
    expect(second.view.attachmentId).toBe('source-b');
    expect(second.slot).toEqual({ primitiveSlot: 9, slotGeneration: 11 });
    expect(second.attribution.status).toBe('unavailable');
  });
});
