import { createBoxGeometry } from '@forgeax/engine-geometry';
import { AssetGuid } from '@forgeax/engine-pack';
import type { Renderer, RenderFeature, RenderFeatureWork } from '@forgeax/engine-render';
import { MeshFilter } from '@forgeax/engine-render';
import { createMaterialProgramArtifactReceipt } from '@forgeax/engine-shader';
import { ok } from '@forgeax/engine-types';
import { ParticleEffectPlayer, type ParticleRendererSourceV3 } from '@forgeax/engine-vfx';
import { cookParticleCodeEffect } from '@forgeax/engine-vfx-compiler';
import { createVfxRuntimeHost } from '@forgeax/engine-vfx-render';
import {
  buildEngineShaderManifest,
  publishShaderManifest,
} from '@forgeax/engine-vite-plugin-shader';
import { expect, onTestFinished } from 'vitest';
import { PARTICLE_MESH_VERTEX_BUFFER } from '../../../render/src/features/particle-mesh-layout';
import { constructRuntimeRendererHost } from '../renderer-host';
import { frameRequest, preparedWorld } from './render-feature-prepared-graphics.fixture';

const manifest = await buildEngineShaderManifest();
const verificationFrames = process.env.FORGEAX_DAWN_LIGHTWEIGHT === '1' ? 2 : 5;
const schema = [
  { name: 'tint', type: 'vec4' },
  { name: 'selector', type: 'u32' },
  { name: 'direction', type: 'i32' },
  { name: 'baseColorTexture', type: 'texture2d' },
] as const;

export const particleDepthLayouts = [
  { name: 'billboard-material-input-instance', location: 9, offset: 31, size: 35, mesh: false },
  {
    name: 'topology-segment-material-input-instance',
    location: 4,
    offset: 12,
    size: 16,
    mesh: false,
  },
  { name: 'mesh-geometry-material-input-instance', location: 10, offset: 18, size: 22, mesh: true },
] as const;
export async function verifyFeatureDepthMaterial(
  layout: (typeof particleDepthLayouts)[number] & {
    readonly particleKind?: ParticleRendererSourceV3['kind'];
    readonly view: boolean;
    readonly missing: 'none' | 'material' | 'depth';
    readonly inputLane?: number;
    readonly allInputs?: boolean;
    readonly writeDepth?: boolean;
    readonly playerMesh?: boolean;
  },
): Promise<void> {
  const { view, missing } = layout;
  const inputLane = layout.inputLane ?? 0;
  const identifier = `test::depth-material-${layout.name}-${view}-${missing}`;
  const instance = new Float32Array(layout.size);
  instance[layout.offset] = 0.5;
  const source = `
${view ? 'struct View { matrix: mat4x4<f32> }; @group(0) @binding(0) var<uniform> view: View;' : ''}
@group(0) @binding(${view ? 1 : 0}) var scene_depth: texture_depth_2d;
struct Material { tint: vec4<f32>, selector: u32, direction: i32 };
@group(1) @binding(0) var<uniform> material: Material;
@group(1) @binding(1) var material_sampler: sampler;
@group(1) @binding(2) var material_texture: texture_2d<f32>;
struct Input { @location(${layout.location + (layout.allInputs ? 3 : inputLane)}) particle: vec4<f32>,
  ${layout.allInputs ? `@location(${layout.location}) first: vec4<f32>, @location(${layout.location + 1}) second: vec4<f32>, @location(${layout.location + 2}) third: vec4<f32>,` : ''}
  ${layout.particleKind === 'mesh' ? '@location(0) geometry: vec3<f32>,' : ''}
};
struct Output { @builtin(position) position: vec4<f32>, @location(0) factor: f32 };
@vertex fn vs_main(input: Input, @builtin(vertex_index) index: u32) -> Output {
  let p = array<vec2<f32>, 3>(vec2(-1., -1.), vec2(3., -1.), vec2(-1., 3.));
  let factor = ${layout.allInputs ? 'select(-1.0, input.particle.x, input.first.x == 3.0 && input.second.x == 1.0 && input.third.x == 2.0)' : 'input.particle.x'};
  return Output(vec4(${layout.particleKind === 'mesh' ? 'input.geometry.xy * 2.0' : 'p[index % 3u]'}, 0.5, 1.), factor);
}
@fragment fn fs_main(input: Output) -> @location(0) vec4<f32> {
  let depth = textureLoad(scene_depth, vec2<i32>(input.position.xy), 0);
  let sampled = textureSampleLevel(material_texture, material_sampler, vec2(0.5), 0.);
  if (material.selector != 3u || material.direction != -7) { return vec4(0., 1., 0., 1.); }
  return vec4(material.tint.rgb * sampled.rgb * (1. - depth) * input.factor, 1.);
}`;
  const shaderManifestUrl = URL.createObjectURL(
    new Blob(
      [
        JSON.stringify(
          publishShaderManifest(manifest.entries, [
            ...manifest.materialShaders,
            ...(layout.writeDepth
              ? [
                  {
                    identifier: `${identifier}-writer`,
                    sourcePath: `${identifier}-writer`,
                    composedWgsl: `@vertex fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
                let p = array<vec2<f32>, 3>(vec2(-1., -1.), vec2(3., -1.), vec2(-1., 3.));
                return vec4(p[index], 0.75, 1.);
              }`,
                    paramSchema: '[]',
                    receipt: {
                      ...createMaterialProgramArtifactReceipt({
                        schema: [],
                        directEntry: 'vs_main',
                        vertexInputs: [],
                      }),
                      bindings: 'group-0',
                    },
                    variants: [],
                  },
                ]
              : []),
            {
              identifier,
              sourcePath: identifier,
              composedWgsl: source,
              paramSchema: JSON.stringify(schema),
              receipt: {
                ...createMaterialProgramArtifactReceipt({
                  schema,
                  directEntry: 'vs_main',
                  vertexInputs: [],
                }),
                bindings: view
                  ? 'render-material-and-scene-depth'
                  : 'render-material-with-scene-depth',
                sceneDepth: 'read-only',
              },
              variants: [],
            },
          ]),
        ),
      ],
      { type: 'application/json' },
    ),
  );
  onTestFinished(() => URL.revokeObjectURL(shaderManifestUrl));
  const materialGuid = AssetGuid.random();
  const meshGuid = AssetGuid.random();
  const particleInputs = layout.allInputs
    ? ['heat', 'warm', 'hot', 'glow'].map((name, lane) => ({
        name,
        type: 'f32' as const,
        visibility: 'fragment' as const,
        lane,
      }))
    : [{ name: 'heat', type: 'f32' as const, visibility: 'fragment' as const, lane: inputLane }];
  const vfx =
    layout.particleKind === undefined
      ? undefined
      : createVfxRuntimeHost({
          camera: {
            read: () => ({
              position: new Float32Array([0, 0, 3]),
              right: new Float32Array([1, 0, 0]),
              up: new Float32Array([0, 1, 0]),
              viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
            }),
          },
        });
  const feature: RenderFeature<undefined> = {
    identity: identifier,
    extract: () => ok(undefined),
    plan: (_, context) => {
      const work = context.views
        .filter((cameraView) => cameraView.render)
        .map((cameraView): RenderFeatureWork => {
          const color = cameraView.targets.find((target) => target.kind === 'color');
          const depth = cameraView.targets.find((target) => target.kind === 'depth');
          if (color === undefined || depth === undefined) throw new Error('Missing scene targets');
          return {
            scope: { view: cameraView.identity },
            resources: [
              ...(layout.writeDepth
                ? [
                    {
                      kind: 'graphics-program' as const,
                      name: 'depth-writer',
                      program: {
                        shader: `${identifier}-writer`,
                        vertexLayout: 'none',
                        colorFormats: [],
                        depthFormat: depth.format,
                        sampleCount: depth.sampleCount,
                        renderState: {
                          depthWriteEnabled: true,
                          depthCompare: 'always' as const,
                          cullMode: 'none' as const,
                        },
                      },
                    },
                    {
                      kind: 'graphics-bindings' as const,
                      name: 'depth-bindings',
                      program: 'depth-writer',
                      values: { group: 0 },
                    },
                  ]
                : []),
              {
                kind: 'graphics-program',
                name: 'program',
                program: {
                  shader: identifier,
                  vertexLayout: layout.name,
                  particleInputLanes: 1,
                  colorFormats: [color.format],
                  sampleCount: color.sampleCount,
                },
              },
              {
                kind: 'graphics-bindings',
                name: 'scene',
                program: 'program',
                values: { group: 0, sceneDepthBinding: view ? 1 : 0 },
                ...(missing === 'depth' ? {} : { logicalTargets: { sceneDepth: depth.name } }),
              },
              {
                kind: 'graphics-bindings',
                name: 'material',
                program: 'program',
                values: { group: 1, material: { world: 0, guid: AssetGuid.format(materialGuid) } },
              },
              { kind: 'vertex-data', name: 'instance', layout: layout.name, data: instance },
              ...(layout.mesh
                ? [
                    {
                      kind: 'vertex-data' as const,
                      name: 'geometry',
                      layout: layout.name,
                      data: new Float32Array((3 * PARTICLE_MESH_VERTEX_BUFFER.arrayStride) / 4),
                    },
                  ]
                : []),
            ],
            passes: [
              ...(layout.writeDepth
                ? [
                    {
                      kind: 'raster' as const,
                      name: 'write-depth',
                      colorAttachments: [],
                      depthStencilAttachment: {
                        target: depth.name,
                        depthLoadOp: 'load' as const,
                        depthStoreOp: 'store' as const,
                      },
                      draws: [
                        {
                          program: 'depth-writer',
                          bindings: ['depth-bindings'],
                          vertexData: [],
                          vertexLayout: 'none' as const,
                          draw: { kind: 'draw' as const, vertexCount: 3, instanceCount: 1 },
                        },
                      ],
                    },
                  ]
                : []),
              {
                kind: 'raster',
                name: 'sample',
                colorAttachments: [{ target: color.name, loadOp: 'load', storeOp: 'store' }],
                sampledTargets: missing === 'depth' ? [] : [depth.name],
                draws: [
                  {
                    program: 'program',
                    bindings: ['scene', 'material'],
                    vertexData: layout.mesh
                      ? [
                          { slot: 0, resource: 'geometry' },
                          { slot: 1, resource: 'instance' },
                        ]
                      : [{ slot: 0, resource: 'instance' }],
                    draw: { kind: 'draw', vertexCount: 3, instanceCount: 1 },
                  },
                ],
              },
            ],
          };
        });
      return ok({ work });
    },
  };
  const particleFeature =
    vfx === undefined
      ? undefined
      : {
          ...vfx.feature,
          plan: (
            data: Parameters<typeof vfx.feature.plan>[0],
            context: Parameters<typeof vfx.feature.plan>[1],
          ) =>
            vfx.feature.plan(
              data,
              missing === 'depth'
                ? {
                    ...context,
                    views: context.views.map((cameraView) => ({
                      ...cameraView,
                      targets: cameraView.targets.filter((target) => target.kind !== 'depth'),
                    })),
                  }
                : context,
            ),
        };
  let device: GPUDevice | undefined;
  let target: GPUTexture | undefined;
  const gpuErrors: string[] = [];
  const canvas = {
    width: 64,
    height: 64,
    getContext: () => ({
      configure(descriptor: { device: GPUDevice; format: GPUTextureFormat }) {
        device = descriptor.device;
        device.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
        target = device.createTexture({
          size: [64, 64],
          format: descriptor.format,
          viewFormats: ['rgba8unorm-srgb'],
          usage: 0x10 | 0x01,
        });
      },
      unconfigure() {},
      getCurrentTexture: () => target,
    }),
    addEventListener() {},
    removeEventListener() {},
  };
  let renderer: Renderer | undefined;
  let attachedWorld: ReturnType<typeof preparedWorld> | undefined;
  try {
    const constructed = await constructRuntimeRendererHost(
      canvas,
      { features: [particleFeature ?? feature] },
      { shaderManifestUrl },
    );
    if (!constructed.ok) throw constructed.error;
    const host = constructed.value;
    renderer = host.renderer;
    const textureGuid = AssetGuid.random();
    if (vfx !== undefined && !layout.playerMesh)
      host.assets.catalog(meshGuid, createBoxGeometry(1, 1, 1).unwrap());
    host.assets.catalog(textureGuid, {
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
      format: 'rgba8unorm',
      data: new Uint8Array([255, 0, 0, 255]),
      colorSpace: 'linear',
      mips: { kind: 'none' },
    });
    if (missing !== 'material')
      host.assets.catalog(materialGuid, {
        kind: 'material',
        passes: [
          {
            name: layout.particleKind === undefined ? 'Forward' : `particle-${layout.particleKind}`,
            program: {
              module: identifier,
              bindings: view
                ? 'render-material-and-scene-depth'
                : 'render-material-with-scene-depth',
              sceneDepth: 'read-only',
            },
            renderState: { tags: { LightMode: 'Forward' }, queue: 3000, depthWriteEnabled: false },
          },
        ],
        ...(vfx === undefined
          ? {}
          : {
              parameters: [
                { name: 'tint', type: 'vec4' },
                { name: 'selector', type: 'u32' },
                { name: 'direction', type: 'i32' },
                { name: 'baseColorTexture', type: 'texture' },
              ],
              particleInputs,
            }),
        values: {
          tint: [0.5, 1, 1, 1],
          selector: 3,
          direction: -7,
          baseColorTexture: { texture: AssetGuid.format(textureGuid) as never },
        },
      });
    const errors: unknown[] = [];
    renderer.subscribe((event) => {
      if (event.kind === 'error') errors.push(event.error);
    });
    const world = preparedWorld();
    const attached = renderer.attach(world);
    if (!attached.ok) throw attached.error;
    const lease = attached.value;
    if (vfx !== undefined) {
      const particleRenderer = {
        kind: layout.particleKind,
        material: AssetGuid.format(materialGuid),
        materialInputs: particleInputs.map((input) => input.name),
        ...(layout.particleKind === 'mesh'
          ? { mesh: layout.playerMesh ? { source: 'player' } : AssetGuid.format(meshGuid) }
          : {}),
        ...(layout.particleKind === 'ribbon' ? { stripKey: 'alive-index', capacity: 4 } : {}),
        ...(layout.particleKind === 'trail' ? { historyLength: 3, capacity: 4 } : {}),
        ...(layout.particleKind === 'beam' ? { endpointField: 'velocity', capacity: 4 } : {}),
      } as ParticleRendererSourceV3;
      const cooked = await cookParticleCodeEffect(
        {
          schemaVersion: 3,
          emitters: [
            {
              id: 'combined',
              capacity: 4,
              backend: { required: 'gpu' },
              space: 'world',
              bounds: { kind: 'sphere', center: [0, 0, 0], radius: 4 },
              schedule: { rate: 0, bursts: [{ time: 0, count: 2 }] },
              program: { module: 'combined.wgsl' },
              renderers: [particleRenderer],
            },
          ],
        },
        {
          'combined.wgsl': {
            entry: `
#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext}
struct VfxParameters { heat: f32, }
struct VfxCustom { heat: f32, ${layout.allInputs ? 'warm: f32, hot: f32, glow: f32,' : ''} }
fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>, custom: ptr<function, VfxCustom>) {
  (*particle).position = vec3<f32>(f32(ctx.particleId) * 0.1, 0.0, 0.0);
  (*particle).velocity = vec3<f32>(0.0, 1.0, 0.0);
  (*particle).mesh_orientation = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  (*particle).mesh_scale = vec3<f32>(1.0);
  (*particle).lifetime = 100.0;
}
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>, custom: ptr<function, VfxCustom>) {
  (*particle).position.x += ctx.delta;
  ${layout.allInputs ? '(*custom).heat = 3.0; (*custom).warm = 1.0; (*custom).hot = 2.0; (*custom).glow = forgeax_vfx_parameters.heat;' : '(*custom).heat = forgeax_vfx_parameters.heat;'}
}`,
          },
        },
        { [AssetGuid.format(materialGuid)]: particleInputs },
      );
      if (!cooked.ok) throw cooked.error;
      const attachment = await vfx.attachWorld({ world, assets: host.assets });
      if (!attachment.ok) throw attachment.error;
      attachedWorld = world;
      const player = world
        .spawn({
          component: ParticleEffectPlayer,
          data: {
            effect: world.allocSharedRef('ParticleEffectAsset', cooked.value.asset),
            playing: true,
            seed: 1,
            timeScale: 1,
          },
        })
        .unwrap();
      if (layout.playerMesh) {
        const mesh = world.allocSharedRef('MeshAsset', createBoxGeometry(1, 1, 1).unwrap());
        world
          .addComponent(player, {
            component: MeshFilter,
            data: { assetHandle: mesh },
          })
          .unwrap();
        world.sharedRefs.release(mesh).unwrap();
      }
      world.update(1 / 60).unwrap();
      const control = vfx.acquireControl(world).unwrap();
      const patched = control.patchPlayerParameters({ player, values: { heat: 0.5 } });
      if (!patched.ok) throw patched.error;
    }
    for (let frame = 0; frame < verificationFrames; frame += 1) {
      expect(world.update(1 / 60).ok).toBe(true);
      const submitted = renderer.draw(frameRequest(lease));
      if (!submitted.ok) throw submitted.error;
      const observed = await renderer.observe(submitted.value, { include: ['draws'] });
      if (!observed.ok) throw observed.error;
    }
    expect(gpuErrors).toEqual([]);
    if (missing !== 'none') {
      expect(errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            detail: expect.objectContaining({
              cause: expect.objectContaining({
                code:
                  vfx !== undefined && missing === 'material'
                    ? 'render-feature-stage-failed'
                    : 'render-feature-preparation-failed',
              }),
            }),
          }),
        ]),
      );
      return;
    }
    expect(errors).toEqual([]);
    if (device === undefined || target === undefined) throw new Error('Missing GPU surface');
    const readback = device.createBuffer({ size: 256 * 64, usage: 0x01 | 0x08 });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: target },
      { buffer: readback, bytesPerRow: 256 },
      [64, 64],
    );
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(1);
    const pixel = new Uint8Array(readback.getMappedRange()).slice(
      32 * 256 + 32 * 4,
      32 * 256 + 32 * 4 + 4,
    );
    readback.unmap();
    readback.destroy();
    if (layout.writeDepth) {
      // Tint 0.5 * red texture 1 * instance 0.5 * forward depth 0.25,
      // reconstructed from raw Reverse-Z 0.75 and encoded into sRGB.
      // Clear depth 0 reconstructs to 1 and cannot pass this oracle.
      const linearRed = 0.5 * 0.5 * 0.25;
      const encodedRed = Math.round((1.055 * linearRed ** (1 / 2.4) - 0.055) * 255);
      expect(Math.abs((pixel[0] ?? 0) - encodedRed)).toBeLessThanOrEqual(2);
    } else expect(pixel[0]).toBeGreaterThan(50);
    expect(pixel[1]).toBeLessThan(5);
    expect(pixel[2]).toBeLessThan(5);
  } finally {
    // Negative material/depth cases return before a readback fence. Drain their
    // submitted work before releasing this headless host's GPU resources.
    if (device !== undefined) await device.queue.onSubmittedWorkDone();
    if (vfx !== undefined && attachedWorld !== undefined)
      await vfx.detachWorld({ world: attachedWorld });
    await renderer?.dispose();
    target?.destroy();
    // This headless fixture owns the raw device. Renderer.dispose releases
    // renderer resources but deliberately leaves device lifetime to its host.
    // Finish this case's device lifetime before starting the next combination.
    if (device !== undefined) {
      device.destroy();
      expect((await device.lost).reason).toBe('destroyed');
    }
  }
}
