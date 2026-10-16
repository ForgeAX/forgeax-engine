import { describe, expect, it } from 'vitest';
import { compileShader } from '../index.js';

const SOURCES = [
  'default-standard-pbr.wgsl',
  'default-standard-pbr-skin.wgsl',
  'unlit.wgsl',
] as const;

const VARIANT_FIXTURE = `
struct VsIn {
  @location(0) position : vec3<f32>,
#ifdef VERTEX_COLOR_AVAILABLE
  @location(13) color : vec4<f32>,
#endif
};
struct VsOut {
  @builtin(position) clip : vec4<f32>,
#ifdef VERTEX_COLOR_AVAILABLE
  @location(14) color : vec4<f32>,
#endif
};
@vertex fn vs_main(in : VsIn) -> VsOut {
  var out : VsOut;
  out.clip = vec4<f32>(in.position, 1.0);
#ifdef VERTEX_COLOR_AVAILABLE
  out.color = in.color;
#endif
  return out;
}
@fragment fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
#ifdef VERTEX_COLOR_AVAILABLE
  return in.color;
#else
  return vec4<f32>(1.0);
#endif
}`;

describe('M4 compiler vertex-color variant matrix', () => {
  it.each(
    SOURCES,
  )('%s compiles both true and false variants with closed color locations', async (file) => {
    for (const available of [true, false]) {
      const result = await compileShader(VARIANT_FIXTURE, {
        id: `forgeax::${file}#color=${available}`,
        defines: {
          VERTEX_COLOR_AVAILABLE: available,
        },
      });
      expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
      if (!result.ok) continue;
      if (available) {
        expect(result.value.wgsl).toMatch(/@location\(13\)\s+color\s*:\s*vec4<f32>/);
        expect(result.value.wgsl).toMatch(/@location\(14\)\s+color\s*:\s*vec4<f32>/);
      } else {
        expect(result.value.wgsl).not.toMatch(/@location\(13\)\s+color\s*:/);
        expect(result.value.wgsl).not.toMatch(/@location\(14\)\s+color\s*:/);
        expect(result.value.wgsl).toMatch(/vec4(?:<f32>)?\([^)]*1(?:\.0|f)?\)/);
      }
    }
  });

  it('rejects authored color varying collisions as a structured compiler error', async () => {
    const result = await compileShader(
      `#pragma variant_axis VERTEX_COLOR_AVAILABLE
struct VsIn { @location(13) color : vec4<f32>, @location(13) authoredColor : vec4<f32>, };
struct VsOut { @builtin(position) clip : vec4<f32>, @location(14) color : vec4<f32>, };
@vertex fn vs_main(in : VsIn) -> VsOut { var out : VsOut; out.clip = in.color; out.color = in.color; return out; }
@fragment fn fs_main(in : VsOut) -> @location(0) vec4<f32> { return in.color; }`,
      { id: 'game::authored-color-collision', defines: { VERTEX_COLOR_AVAILABLE: true } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('shader-compile-failed');
      expect(result.error.hint).toBeTypeOf('string');
    }
  });
});
