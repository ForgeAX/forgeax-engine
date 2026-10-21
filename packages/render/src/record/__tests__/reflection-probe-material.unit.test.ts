import type { Buffer, Sampler, TextureView } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import type { SkylightBindGroupResources } from '../../ibl/skylight-bind-group';
import {
  buildReflectionProbeTable,
  type ReflectionProbeTableRow,
} from '../../reflection/gpu-table';
import { reflectionProbeMaterial } from '../reflection-probe-material';
import type { ReflectionProbeRecordState } from '../render-context';

const skylight = {
  irradianceView: {},
  irradianceSampler: {},
  prefilterView: {},
  prefilterSampler: {},
  brdfLutView: {},
  intensityBuffer: {},
} as SkylightBindGroupResources;
function probe(index: number): ReflectionProbeTableRow {
  return {
    index,
    primitiveKey: `2:${index + 100}`,
    worldId: 2,
    entityKey: index + 100,
    center: [0, 0, 0],
    halfExtents: [1, 1, 1],
    intensity: 1,
    generation: 1,
    filteredView: {} as TextureView,
    sampler: {} as Sampler,
    uniformBuffer: {} as Buffer,
  };
}
const unreadableSelections = {
  get(): never {
    throw new Error('GPU queried entity probe selection');
  },
} as unknown as ReflectionProbeRecordState['selections'];

describe('shared reflection probe resource classes', () => {
  it('resolves a sparse class directly and preserves the skylight irradiance and BRDF', () => {
    const target = probe(41);
    const table = buildReflectionProbeTable([target, probe(2), probe(13)]);
    const result = reflectionProbeMaterial(
      { table, selections: unreadableSelections },
      skylight,
      'probe:41',
    );
    expect(result).toEqual({
      probeIndex: 41,
      resources: {
        irradianceView: skylight.irradianceView,
        irradianceSampler: skylight.irradianceSampler,
        prefilterView: target.filteredView,
        skylightPrefilterView: skylight.prefilterView,
        prefilterSampler: target.sampler,
        brdfLutView: skylight.brdfLutView,
        intensityBuffer: target.uniformBuffer,
      },
    });
  });

  it('resolves direct entity selection through the same resource table', () => {
    const target = probe(41);
    const table = buildReflectionProbeTable([target]);
    const selections: ReflectionProbeRecordState['selections'] = new Map([
      ['0:7', { kind: 'probe', worldId: 2, entityKey: 141, normalizedDistance: 0 }],
    ]);
    expect(reflectionProbeMaterial({ table, selections }, skylight, '', 0, 7)).toEqual(
      reflectionProbeMaterial({ table, selections: unreadableSelections }, skylight, 'probe:41'),
    );
  });

  it.each([
    'probe:1',
    'probe:-1',
    'probe:NaN',
    'probe:2.5',
    undefined,
  ])('keeps the skylight fallback for missing class %s', (resourceClass) => {
    const table = buildReflectionProbeTable([probe(2)]);
    expect(
      reflectionProbeMaterial({ table, selections: unreadableSelections }, skylight, resourceClass),
    ).toBeUndefined();
  });

  it.each([
    'filteredView',
    'sampler',
    'uniformBuffer',
  ] as const)('keeps the fallback until %s is ready', (field) => {
    const target = { ...probe(41) };
    delete target[field];
    const table = buildReflectionProbeTable([target]);
    expect(
      reflectionProbeMaterial({ table, selections: unreadableSelections }, skylight, 'probe:41'),
    ).toBeUndefined();
  });
});
