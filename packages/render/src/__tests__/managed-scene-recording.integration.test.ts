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
import { Camera, CubeCamera, DirectionalLight, MeshFilter, MeshRenderer } from '../components';
import * as execution from '../gpu-driven/material-artifacts';
import { Materials } from '../materials';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

function result<T>(
  value: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown },
): T {
  if (!value.ok) throw value.error;
  return value.value;
}

it.each(
  (['mixed', 'no-indirect', 'direct'] as const).flatMap((mode) =>
    [false, true].map((capture) => ({ mode, capture })),
  ),
)('keeps complete shadows and one display writer ($mode, capture=$capture)', async ({
  mode,
  capture,
}) => {
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
    { shaderManifestUrl: `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}` },
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
    for (const [index, material] of materials.entries())
      world
        .spawn(
          { component: Transform, data: { pos: [index === 0 ? -0.75 : 0.75, 0, 0] } },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: { materials: [material] } },
        )
        .unwrap();
    if (capture) {
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
          { component: Transform, data: { pos: [0, 0, 5] } },
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
    for (let frame = 0; frame < 3; frame++) {
      passes.length = 0;
      draws.length = 0;
      world.update().unwrap();
      const receipt = result(
        renderer.draw({
          leases: [lease],
          camera: { lease },
          environment: { lease },
          geometryLane: mode === 'direct' ? 'direct' : 'automatic',
        }),
      );
      if (receipt !== undefined) result(await receipt.completed);
      expect(errors).toEqual([]);
      expect(passes.find((pass) => pass.pass === 'main')?.count).toBe(2);
      const captureIndex = passes.findIndex((pass) => pass.pass.startsWith('cube-capture-face'));
      if (capture) {
        expect(captureIndex).toBeGreaterThanOrEqual(0);
        expect(passes[captureIndex]?.count).toBe(2);
        expect(
          passes
            .slice(0, captureIndex)
            .filter((pass) => pass.pass.startsWith('shadowCascade'))
            .reduce((sum, pass) => sum + pass.count, 0),
        ).toBe(2);
      } else expect(captureIndex).toBe(-1);
      if (frame === 0) {
        expect(
          passes
            .slice(captureIndex + 1)
            .filter((pass) => pass.pass.startsWith('shadowCascade'))
            .reduce((sum, pass) => sum + pass.count, 0),
        ).toBe(2);
        expect(draws.filter((draw) => draw.pass === 'main' && !draw.indirect)).toHaveLength(
          mode === 'mixed' ? 1 : 2,
        );
        expect(draws.some((draw) => draw.indirect)).toBe(mode === 'mixed');
      }
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
