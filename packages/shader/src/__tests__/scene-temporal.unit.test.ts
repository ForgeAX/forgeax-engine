import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const localTemporalShaders = ['unlit.wgsl', 'sprite.wgsl', 'sprite-lit.wgsl'] as const;

const pbrTemporalConsumers = [
  'default-standard-pbr.wgsl',
  'default-standard-pbr-skin.wgsl',
] as const;

describe('scene temporal varyings', () => {
  it.each([
    ...localTemporalShaders,
    ...pbrTemporalConsumers,
  ])('%s shares main-depth raster coverage without jittering motion', (file) => {
    const source = readFileSync(resolve(import.meta.dirname, '..', file), 'utf8');
    expect(source).toContain('out.clip = view.worldViewProj * currentWorld;');
    expect(source).toContain('out.currentClip = view.temporalCurrentViewProj * currentWorld;');
    expect(source).not.toContain('out.clip = out.currentClip;');
    expect(source.match(/@builtin\(position\) @invariant clip/g)).toHaveLength(2);
  });
  it('defines the temporal-v1 accessor ABI in one owner module', () => {
    const source = readFileSync(resolve(import.meta.dirname, '..', 'scene-temporal.wgsl'), 'utf8');
    expect(source).toContain('struct SceneTemporalV1');
    expect(source).toContain('fn unpackSceneTemporalV1');
    expect(source).toContain('motionUv = packed.xy');
    expect(source).toContain('exp2(packed.z) - 1.0');
    expect(source).toContain('reactive = clamp(packed.w');
    expect(source).toContain('packed.z < 0.0');
    expect(source).toContain('SCENE_DATA_TEMPORAL_V1_CLEAR');
    expect(source).toContain('rgba16float');
    expect(source).toContain('fn sceneViewZ');
    expect(source).toContain('orthographicViewZ = -(temporalProjection.y');
    expect(source).toContain('packed.w >= 2.0');
    expect(source).toContain('select(0.0, 2.0, !motionValid)');
  });

  it('uses projection depth rather than Euclidean distance for cluster view Z', () => {
    const sceneViewZ = (
      clip: { readonly z: number; readonly w: number },
      temporalProjection: { readonly x: number; readonly y: number; readonly z: number },
    ) => {
      const ndcDepth = clip.z / Math.max(Math.abs(clip.w), 1e-6);
      const orthographicViewZ = -(
        temporalProjection.x +
        ndcDepth * (temporalProjection.y - temporalProjection.x)
      );
      return temporalProjection.z >= 0.5 ? orthographicViewZ : -clip.w;
    };

    expect(sceneViewZ({ z: 0.5, w: 1 }, { x: 1, y: 11, z: 1 })).toBe(-6);
    expect(sceneViewZ({ z: 3, w: 7 }, { x: 1, y: 11, z: 0 })).toBe(-7);
  });

  it.each(localTemporalShaders)('%s perspective-interpolates both clip authorities', (file) => {
    const source = readFileSync(resolve(import.meta.dirname, '..', file), 'utf8');
    expect(source).toMatch(/@interpolate\(perspective\) currentClip : vec4<f32>/);
    expect(source).toMatch(/@interpolate\(perspective\) previousClip : vec4<f32>/);
    expect(source).not.toMatch(
      /@interpolate\((?:linear|noperspective)\) (?:currentClip|previousClip)/,
    );
  });

  it('keeps PBR UV selection and fragment projection in one module', () => {
    const source = readFileSync(resolve(import.meta.dirname, '..', 'pbr-temporal.wgsl'), 'utf8');
    expect(source).toContain('fn transformedPbrTemporalUv');
    expect(source).toContain('fn projectPbrSceneTemporal');
  });

  it.each(pbrTemporalConsumers)('%s imports the shared PBR temporal authority', (file) => {
    const source = readFileSync(resolve(import.meta.dirname, '..', file), 'utf8');
    expect(source).toMatch(/#import forgeax_scene_temporal::\{[^}]*\bsceneViewZ\b/);
    expect(source).toMatch(/#import forgeax_pbr::temporal::\{[^}]*\bprojectPbrSceneTemporal\b/);
    expect(source).toMatch(/@interpolate\(perspective\) currentClip : vec4<f32>/);
    expect(source).toMatch(/@interpolate\(perspective\) previousClip : vec4<f32>/);
    expect(source).not.toMatch(
      /@interpolate\((?:linear|noperspective)\) (?:currentClip|previousClip)/,
    );
    expect(source).not.toContain('fn transformedTemporalUv');
  });
});
