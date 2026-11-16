import { expect, it } from 'vitest';
import { resolveMaterialPipelineVertexEntry } from '../pipeline-helpers';

it('leaves an omitted packed vertex entry to the pass-specific pipeline default', () => {
  // Temporal uses vs_temporal; inventing vs_main_packed here pairs the color
  // vertex output with fs_temporal and makes the native pipeline reject.
  expect(resolveMaterialPipelineVertexEntry('pbr', undefined, undefined, true)).toBeUndefined();
  expect(resolveMaterialPipelineVertexEntry('pbr', undefined, undefined)).toBeUndefined();
});

it('packs explicit entries once and retains the scene-index receipt authority', () => {
  expect(resolveMaterialPipelineVertexEntry('pbr', undefined, 'vs_temporal', true)).toBe(
    'vs_temporal_packed',
  );
  expect(resolveMaterialPipelineVertexEntry('pbr', undefined, 'vs_temporal_packed', true)).toBe(
    'vs_temporal_packed',
  );
  expect(
    resolveMaterialPipelineVertexEntry('gpu-driven-pbr', 'vs_scene_index', 'vs_authored', true),
  ).toBe('vs_scene_index_packed');
  expect(resolveMaterialPipelineVertexEntry('pbr', 'vs_main', 'vs_authored')).toBe('vs_authored');
});
