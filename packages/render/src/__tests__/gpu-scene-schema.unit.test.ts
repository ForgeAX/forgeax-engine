import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { STANDARD_PIPELINE_PARAM_SCHEMA } from '@forgeax/engine-shader';
import { derive } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  GPU_SCENE_LAYOUTS,
  GPU_SCENE_WGSL,
  gpuSceneFieldOffset,
  gpuSceneWgsl,
} from '../gpu-scene-schema';

describe('GPU Scene schema derivation', () => {
  it('retains the two-component normal strength and bump strength in the material row', () => {
    const layout = GPU_SCENE_LAYOUTS.material;
    const members = derive(STANDARD_PIPELINE_PARAM_SCHEMA).numericMembers;
    for (const name of ['normalScale', 'bumpScale']) {
      expect(gpuSceneFieldOffset(layout, name)).toBe(
        members.find((member) => member.name === name)?.offset,
      );
    }
    expect(layout.fields.find((field) => field.name === 'normalScale')).toMatchObject({
      type: 'vec2<f32>',
      size: 8,
      alignment: 8,
    });
    expect(GPU_SCENE_WGSL).toContain('normalScale: vec2<f32>');
  });

  it('derives CPU strides, offsets, and WGSL from one field roster', () => {
    expect(GPU_SCENE_LAYOUTS.primitive.stride).toBe(64);
    expect(gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.primitive, 'localBoundsMin')).toBe(32);
    expect(gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.primitive, 'localBoundsMax')).toBe(48);
    expect(GPU_SCENE_LAYOUTS.transform.stride).toBe(128);
    expect(gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.transform, 'previousWorld')).toBe(64);
    expect(GPU_SCENE_WGSL).toContain('struct GpuScenePrimitive');
    expect(GPU_SCENE_WGSL).toContain('currentWorld: mat4x4<f32>');
    expect(GPU_SCENE_WGSL).toContain('struct GpuSceneMaterial');
    expect(GPU_SCENE_WGSL).toContain('baseVertex: i32');
  });

  it('pins the shader-side scene-index structs to the derived table layouts', () => {
    const common = readFileSync(
      resolve(import.meta.dirname, '../../../shader/src/common.wgsl'),
      'utf8',
    );
    for (const layout of [
      GPU_SCENE_LAYOUTS.primitive,
      GPU_SCENE_LAYOUTS.instance,
      GPU_SCENE_LAYOUTS.transform,
    ]) {
      const declared = common.match(new RegExp(`struct ${layout.name} \\{[\\s\\S]*?\\n\\};`));
      expect(declared?.[0]).toBe(gpuSceneWgsl(layout));
    }
  });
});
