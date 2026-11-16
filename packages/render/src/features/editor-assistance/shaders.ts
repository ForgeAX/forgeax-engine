import { OUTLINE_PROGRAMS } from '../outline/shaders';
/** Inline programs use the ordinary Feature program/graphics/resource lifecycle. */
export function editorAssistanceShader(depth: 'always' | 'occluded', samples: 1 | 4): string {
  const declaration =
    depth === 'always'
      ? ''
      : `@group(1) @binding(0) var sceneColor: texture_2d<f32>;
@group(1) @binding(3) var sceneDepth: ${samples === 4 ? 'texture_depth_multisampled_2d' : 'texture_depth_2d'};`;
  const occlusion =
    depth === 'always'
      ? ''
      : `
    let uv = input.position.xy / vec2<f32>(textureDimensions(sceneColor));
    let pixel = min(vec2<i32>(uv * vec2<f32>(textureDimensions(sceneDepth))), vec2<i32>(textureDimensions(sceneDepth)) - vec2<i32>(1));
    var sceneZ = textureLoad(sceneDepth, pixel, 0);
    ${samples === 4 ? 'for (var sample = 1; sample < 4; sample++) { sceneZ = max(sceneZ, textureLoad(sceneDepth, pixel, sample)); }' : ''}
    if (input.position.z < sceneZ - max(sceneZ * 0.000002, 1e-12)) { discard; }
  `;
  return /* wgsl */ `
struct Output { @builtin(position) position: vec4<f32>, @location(0) color: vec4<f32> };
${declaration}
@vertex fn vs_main(@location(0) position: vec4<f32>, @location(1) color: vec4<f32>) -> Output {
  return Output(position, color);
}
@fragment fn fs_main(input: Output) -> @location(0) vec4<f32> {
  ${occlusion}
  return input.color;
}`;
}

export const EDITOR_ASSISTANCE_COPY_SHADER = /* wgsl */ `
struct Output { @builtin(position) position: vec4<f32> };
@group(1) @binding(0) var sceneColor: texture_2d<f32>;
@vertex fn vs_main(@builtin(vertex_index) i: u32) -> Output {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return Output(vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0));
}
@fragment fn fs_main(input: Output) -> @location(0) vec4<f32> {
  return textureLoad(sceneColor, vec2<i32>(input.position.xy), 0);
}`;

export const EDITOR_OUTLINE_PROGRAMS = Object.freeze(
  OUTLINE_PROGRAMS.map((program) =>
    Object.freeze({
      ...program,
      name: program.name.replace('forgeax.outline', 'forgeax.editor-outline'),
    }),
  ),
);
