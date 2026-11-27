import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { RhiNullDevice, RhiNullRenderPassEncoder, rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import {
  createMaterialProgramArtifactReceipt,
  createStandardPbrArtifactReceipt,
} from '@forgeax/engine-shader';
import type { MaterialPass } from '@forgeax/engine-types';
import { assert, expect, it, vi } from 'vitest';
import { createRenderer } from '../assembly/factory';
import {
  Camera,
  CubeCamera,
  DirectionalLight,
  Instances,
  MeshFilter,
  MeshRenderer,
  PlanarReflection,
} from '../components';
import * as execution from '../gpu-driven/material-artifacts';
import { Materials } from '../materials';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

function result<T>(
  value: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown },
): T {
  if (!value.ok) throw value.error;
  return value.value;
}

function recordingFixtureManifest(): string {
  const source = renderLifecycleManifestUrl();
  const manifest = JSON.parse(decodeURIComponent(source.slice(source.indexOf(',') + 1)));
  for (const entry of manifest.materialShaders) {
    if (entry.identifier === 'forgeax::default-shadow-caster') {
      entry.receipt = createMaterialProgramArtifactReceipt({
        schema: [],
        directEntry: 'vs_main',
        sceneIndexEntry: 'vs_scene_index',
        vertexInputs: [{ semantic: 'position', location: 0, format: 'float32x3' }],
      });
      for (const variant of entry.variants) variant.receipt = entry.receipt;
      continue;
    }
    if (entry.identifier !== 'forgeax::default-standard-pbr') continue;
    entry.receipt = createStandardPbrArtifactReceipt(false, false);
    for (const variant of entry.variants)
      variant.receipt = createStandardPbrArtifactReceipt(
        false,
        variant.defines.VERTEX_COLOR_AVAILABLE === true,
      );
  }
  return `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;
}

function expectRecordingFrame(
  passes: readonly { pass: string; count: number }[],
  draws: readonly { pass: string; indirect: boolean }[],
  mode: 'mixed' | 'no-indirect' | 'direct',
  capture: 'none' | 'cube' | 'planar',
  movingShadow: boolean,
  frame: number,
): void {
  expect(passes.find((pass) => pass.pass.split(' + ').includes('main'))?.count).toBe(2);
  const captureIndex = passes.findIndex((pass) => pass.pass.startsWith('cube-capture-face'));
  if (capture === 'cube') {
    expect(captureIndex).toBeGreaterThanOrEqual(0);
    // The first three cube faces are +X, -X, +Y. From x=-5 only
    // +X sees the two geometry rows; other faces must record no residual.
    const captureDraws = frame === 0 ? 2 : 0;
    expect(passes[captureIndex]?.count).toBe(captureDraws);
    expect(
      passes
        .slice(0, captureIndex)
        .filter((pass) => pass.pass.startsWith('shadowCascade'))
        .reduce((sum, pass) => sum + pass.count, 0),
    ).toBe(2);
  } else expect(captureIndex).toBe(-1);
  if (capture === 'planar') {
    expect(passes.find(({ pass }) => pass.includes('planar-reflection-face'))?.count).toBe(2);
    expect(
      draws.filter(({ pass, indirect }) => pass.includes('planar-reflection-face') && !indirect),
    ).toHaveLength(2);
  }
  if (movingShadow) {
    expect(passes.find(({ pass }) => pass.startsWith('shadowCascade'))?.count).toBe(2);
    expect(
      draws.filter(({ pass, indirect }) => pass.startsWith('shadowCascade') && !indirect),
    ).toHaveLength(2);
  }
  if (frame === 0) {
    expect(
      passes
        .slice(captureIndex + 1)
        .filter((pass) => pass.pass.startsWith('shadowCascade'))
        .reduce((sum, pass) => sum + pass.count, 0),
    ).toBe(2);
    expect(
      draws.filter((draw) => draw.pass.split(' + ').includes('main') && !draw.indirect),
    ).toHaveLength(mode === 'mixed' ? 1 : 2);
    expect(draws.some((draw) => draw.indirect)).toBe(mode === 'mixed');
  }
}

it.each(
  (['mixed', 'no-indirect', 'direct'] as const).flatMap((mode) =>
    (mode === 'direct' ? (['none', 'cube', 'planar'] as const) : (['none', 'cube'] as const)).map(
      (capture) => ({ mode, capture }),
    ),
  ),
)('keeps complete shadows and one display writer ($mode, capture=$capture)', async ({
  mode,
  capture,
}) => {
  const shaderManifestUrl = recordingFixtureManifest();
  const capsGetter = Object.getOwnPropertyDescriptor(RhiNullDevice.prototype, 'caps')?.get;
  assert(capsGetter);
  mode === 'no-indirect'
    ? vi.spyOn(RhiNullDevice.prototype, 'caps', 'get').mockImplementation(function (
        this: RhiNullDevice,
      ) {
        return { ...capsGetter.call(this), indirectDrawing: false };
      })
    : undefined;
  const renderer = await createRenderer(
    { width: 32, height: 32, getContext: () => null },
    undefined,
    { shaderManifestUrl },
    { rhi, createShaderModule: (device, descriptor) => rhi.createShaderModule(device, descriptor) },
  );
  try {
    result(await renderer.initialization);
    const assets = renderer.assetRegistry;
    const world = new World({ assets });
    const lease = result(renderer.attach(world));
    registerPropagateTransforms(world);
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 5] } },
        { component: Camera, data: { fov: 1, aspect: 1, near: 0.1, far: 20, antialias: 0 } },
      )
      .unwrap();
    world
      .spawn({
        component: DirectionalLight,
        data: { direction: [0, -1, -1], castShadow: true, cascadeCount: 1, mapSize: 64 },
      })
      .unwrap();
    const mesh = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
    const standard = Materials.standard({ baseColor: [1, 1, 1, 1] });
    assert(standard.parent === undefined && standard.passes !== undefined);
    const directPass = (pass: MaterialPass): MaterialPass => ({
      ...pass,
      renderState: { ...pass.renderState, stencil: { compare: 'always' as const } },
    });
    const [first, ...rest] = standard.passes;
    const materials = [
      assets.create(standard).unwrap(),
      assets
        .create({
          ...standard,
          passes: [directPass(first), ...rest.map(directPass)],
        })
        .unwrap(),
    ];
    const objects = materials.map((material, index) =>
      world
        .spawn(
          { component: Transform, data: { pos: [index === 0 ? -0.75 : 0.75, 0, 0] } },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: { materials: [material] } },
        )
        .unwrap(),
    );
    const mirror =
      capture === 'planar'
        ? result(
            renderer.createRenderTarget({
              shape: '2d',
              width: 16,
              height: 16,
              format: 'rgba16float',
              mipLevels: 1,
              sampleCount: 1,
              sampled: true,
              readback: false,
            }),
          )
        : undefined;
    if (mirror !== undefined)
      world
        .addComponent(camera, {
          component: PlanarReflection,
          data: { distance: 1, target: world.allocSharedRef('RenderTarget', mirror) },
        })
        .unwrap();
    if (capture === 'cube') {
      const target = result(
        renderer.createRenderTarget({
          shape: 'cube',
          width: 16,
          height: 16,
          format: 'rgba8unorm',
          mipLevels: 1,
          sampleCount: 1,
          sampled: true,
          readback: true,
        }),
      );
      world
        .spawn(
          { component: Transform, data: { pos: [-5, 0, 0] } },
          {
            component: CubeCamera,
            data: {
              target: world.allocSharedRef('RenderTarget', target),
              faceBudget: 1,
              updateIntent: 2,
            },
          },
        )
        .unwrap();
    }
    const errors: unknown[] = [];
    renderer.onError((error) => errors.push(error));
    const executions = vi.spyOn(execution, 'collectGpuDrivenMaterialArtifacts');
    const draws: { pass: string; indirect: boolean }[] = [];
    const passes: { pass: string; count: number }[] = [];
    const bundleReplays = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'executeBundles');
    const movingShadow = mode === 'direct' && capture === 'none';
    const end = RhiNullRenderPassEncoder.prototype.end;
    const drawIndexed = RhiNullRenderPassEncoder.prototype.drawIndexed;
    const drawIndexedIndirect = RhiNullRenderPassEncoder.prototype.drawIndexedIndirect;
    vi.spyOn(RhiNullRenderPassEncoder.prototype, 'end').mockImplementation(function (
      this: RhiNullRenderPassEncoder,
    ) {
      passes.push({ pass: this.passName, count: this.drawCount });
      end.call(this);
    });
    vi.spyOn(RhiNullRenderPassEncoder.prototype, 'drawIndexed').mockImplementation(function (
      this: RhiNullRenderPassEncoder,
      ...args
    ) {
      draws.push({ pass: this.passName, indirect: false });
      drawIndexed.apply(this, args);
    });
    vi.spyOn(RhiNullRenderPassEncoder.prototype, 'drawIndexedIndirect').mockImplementation(
      function (this: RhiNullRenderPassEncoder, ...args) {
        draws.push({ pass: this.passName, indirect: true });
        drawIndexedIndirect.apply(this, args);
      },
    );
    for (let frame = 0; frame < (capture === 'planar' || movingShadow ? 6 : 3); frame++) {
      passes.length = 0;
      draws.length = 0;
      if (movingShadow) {
        const [caster] = objects;
        assert(caster !== undefined);
        world.set(caster, Transform, { pos: [-0.75, 0, frame * 0.05] }).unwrap();
      }
      world.update().unwrap();
      const receipt = result(
        renderer.draw({ source: lease, geometryLane: mode === 'direct' ? 'direct' : 'automatic' }),
      );
      if (receipt !== undefined) result(await receipt.completed);
      expect(errors).toEqual([]);
      expectRecordingFrame(passes, draws, mode, capture, movingShadow, frame);
    }
    if (mode === 'direct') expect(bundleReplays).not.toHaveBeenCalled();
    if (mirror !== undefined) {
      const independentTarget = result(
        renderer.createRenderTarget({
          shape: '2d',
          width: 16,
          height: 16,
          format: 'rgba16float',
          mipLevels: 1,
          sampleCount: 1,
          sampled: true,
          readback: false,
        }),
      );
      const independentSource = result(
        renderer.createRenderTargetTextureSource(independentTarget, {
          aspect: 'color',
          dimension: '2d',
          mipLevel: 0,
        }),
      );
      const source = result(
        renderer.createRenderTargetTextureSource(mirror, {
          aspect: 'color',
          dimension: '2d',
          mipLevel: 0,
        }),
      );
      const feedbackMaterial = assets
        .create(Materials.unlit([1, 1, 1, 1], { baseColorTexture: { source: independentSource } }))
        .unwrap();
      const [object] = objects;
      const [ordinaryMaterial] = materials;
      assert(object !== undefined && ordinaryMaterial !== undefined);
      const checkCapture = async (draws: number) => {
        passes.length = 0;
        world.update().unwrap();
        const receipt = result(renderer.draw({ source: lease, geometryLane: 'direct' }));
        assert(receipt !== undefined);
        result(await receipt.completed);
        expect(passes.find(({ pass }) => pass.includes('planar-reflection-face'))?.count).toBe(
          draws,
        );
      };
      world.set(object, MeshRenderer, { materials: [feedbackMaterial] }).unwrap();
      await checkCapture(2);
      assets.update(feedbackMaterial, { values: { baseColorTexture: { source } } }).unwrap();
      await checkCapture(1);
      assets
        .update(feedbackMaterial, { values: { baseColorTexture: { source: independentSource } } })
        .unwrap();
      await checkCapture(2);
      world.set(object, MeshRenderer, { materials: [ordinaryMaterial] }).unwrap();
      await checkCapture(2);
    }
    expect(errors).toEqual([]);
    const selected = executions.mock.results.flatMap((r) =>
      r.value === undefined ? [] : [...r.value.batchExecutions.values()].map((e) => e.shadow.route),
    );
    if (mode !== 'direct') expect(new Set(selected)).toEqual(new Set(['gpu', 'direct']));
  } finally {
    vi.restoreAllMocks();
    result(renderer.dispose());
  }
});

it('submits the resident instance range directly in every sorted transparency pass', async () => {
  const renderer = await createRenderer(
    { width: 32, height: 32, getContext: () => null },
    undefined,
    { shaderManifestUrl: renderLifecycleManifestUrl() },
    { rhi, createShaderModule: (device, descriptor) => rhi.createShaderModule(device, descriptor) },
  );
  try {
    result(await renderer.initialization);
    const assets = renderer.assetRegistry;
    const world = new World({ assets });
    const lease = result(renderer.attach(world));
    registerPropagateTransforms(world);
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 5] } },
        { component: Camera, data: { fov: 1, aspect: 1, near: 0.1, far: 20, antialias: 0 } },
      )
      .unwrap();
    const mesh = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
    const material = assets
      .create(Materials.unlit([1, 0, 0, 0.5], { blendMode: 'additive' }))
      .unwrap();
    const transforms = Float32Array.of(
      1,
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      1,
      0,
      -1,
      0,
      0,
      1,
      1,
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      1,
      0,
      1,
      0,
      0,
      1,
    );
    const entity = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
        { component: Instances, data: { transforms } },
      )
      .unwrap();
    const drawIndexed = RhiNullRenderPassEncoder.prototype.drawIndexed;
    const transparentInstances: number[] = [];
    vi.spyOn(RhiNullRenderPassEncoder.prototype, 'drawIndexed').mockImplementation(function (
      this: RhiNullRenderPassEncoder,
      ...args
    ) {
      if (this.passName.includes('transparent')) transparentInstances.push(args[1] ?? 1);
      drawIndexed.apply(this, args);
    });
    const replay = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'executeBundles');
    for (let frame = 0; frame < 6; frame++) {
      if (frame === 4) world.setArrayRange(entity, Instances, 'transforms', 12, [-0.5]).unwrap();
      world.update().unwrap();
      const receipt = result(renderer.draw({ source: lease, geometryLane: 'direct' }));
      assert(receipt !== undefined);
      result(await receipt.completed);
      expect(transparentInstances.splice(0)).toEqual([2]);
    }
    expect(replay).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    result(renderer.dispose());
  }
});
