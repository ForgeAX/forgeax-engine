import { createFullscreenRenderFeature } from '@forgeax/engine/app';
import { PostProcessParams } from '@forgeax/engine/render';
import { CheckList, defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

const IDENTITY = 'feature-lab::invert-post';

const SOURCE = `
struct Output { @builtin(position) position : vec4<f32>, @location(0) uv : vec2<f32>, };
struct Params { mode : f32, pad0 : f32, pad1 : f32, pad2 : f32, };
@vertex fn vs_main(@builtin(vertex_index) i : u32) -> Output {
  var x : f32 = -1.0;
  var y : f32 = -1.0;
  if (i == 1u) { x = 3.0; }
  if (i == 2u) { y = 3.0; }
  var out : Output;
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>((x + 1.0) * 0.5, 1.0 - (y + 1.0) * 0.5);
  return out;
}
@group(1) @binding(0) var sourceTexture : texture_2d<f32>;
@group(1) @binding(1) var sourceSampler : sampler;
@group(1) @binding(2) var<uniform> params : Params;
@fragment fn fs_main(in : Output) -> @location(0) vec4<f32> {
  let c = textureSample(sourceTexture, sourceSampler, in.uv).rgb;
  if (params.mode < 0.5) { return vec4<f32>(c, 1.0); }
  return vec4<f32>(1.0 - c, 1.0);
}
`;

const invert = createFullscreenRenderFeature({
  identity: IDENTITY,
  source: SOURCE,
  params: { byteSize: 16, defaultValue: new Uint8Array(16) },
});

function mode(value: number): Uint8Array {
  return new Uint8Array(new Float32Array([value, 0, 0, 0]).buffer);
}

export default defineFeature({
  title: 'Custom fullscreen post-processing',
  catalog: 'Custom fullscreen post-processing',
  kind: 'visual',
  appOptions: { features: [invert] },
  summary:
    'createFullscreenRenderFeature({ identity, source, params }) joins a WGSL fullscreen effect to the Standard post stage; a PostProcessParams entity drives its uniform from ECS.',
  expect:
    'ON: the whole frame is color-inverted (dark background turns near-white, the orange sphere turns blue). OFF: the normal scene.',
  setup({ app, world }) {
    spawnStage(world);
    spawnMesh(world, MESH.sphere, standard(world, { baseColor: [1, 0.5, 0.1, 1] }), {
      pos: [0, 0.7, 0],
    });
    const params = world
      .spawn({ component: PostProcessParams, data: { shader: IDENTITY, data: mode(1) } })
      .unwrap();
    return {
      toggle(on) {
        world.set(params, PostProcessParams, { data: mode(on ? 1 : 0) } as never).unwrap();
      },
      checks() {
        const status = app.renderer
          .inspect()
          .featureDiagnostics.find((entry) => entry.identity === IDENTITY);
        return new CheckList()
          .equal('effect admitted', status?.status, 'active')
          .ok(
            'no feature error',
            status?.latestError === undefined,
            JSON.stringify(status?.latestError),
          ).items;
      },
    };
  },
});
