import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { createProfiler } from '@forgeax/engine-profiler';
import { rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { createStandardPbrArtifactReceipt } from '@forgeax/engine-shader';
import { expect, it, vi } from 'vitest';
import { createRenderer } from '../assembly/factory';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '../components';
import { IndirectPassBindings } from '../gpu-driven/production-raster-encode';
import { Materials } from '../materials';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

it.each([
  0, 3,
])('leaves camera rejection to the GPU cull and replays retained commands (antialias=%s)', async (antialias) => {
  const source = renderLifecycleManifestUrl();
  const manifest = JSON.parse(decodeURIComponent(source.slice(source.indexOf(',') + 1)));
  for (const entry of manifest.materialShaders) {
    if (entry.identifier !== 'forgeax::default-standard-pbr') continue;
    // RhiNull checks routing only; these markers extend the maintained
    // placeholder manifest for the temporal source admission contract.
    entry.composedWgsl += '\nfn vs_temporal() {}\nfn fs_temporal() {}\n';
    entry.receipt = createStandardPbrArtifactReceipt(false, false);
    for (const variant of entry.variants) {
      variant.composedWgsl = entry.composedWgsl;
      variant.receipt = createStandardPbrArtifactReceipt(
        false,
        variant.defines.VERTEX_COLOR_AVAILABLE === true,
      );
    }
  }
  const profiler = createProfiler();
  const renderer = await createRenderer(
    { width: 64, height: 64, getContext: () => null },
    { profiler },
    { shaderManifestUrl: `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}` },
    {
      rhi,
      createShaderModule: async (device, descriptor) => rhi.createShaderModule(device, descriptor),
    },
  );
  const initialized = await renderer.initialization;
  if (!initialized.ok) throw initialized.error;
  const assets = renderer.assetRegistry;
  const world = new World({ assets });
  const attachment = renderer.attach(world);
  if (!attachment.ok) throw attachment.error;
  const attached = attachment.value;
  registerPropagateTransforms(world);
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 4] } },
      { component: Camera, data: { fov: 1, aspect: 1, near: 0.1, far: 100, antialias } },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: {} },
      {
        component: DirectionalLight,
        data: { castShadow: true, direction: [0, -1, -1], color: [1, 1, 1], intensity: 1 },
      },
    )
    .unwrap();
  const material = assets.create(Materials.standard({ baseColor: [1, 1, 1, 1] })).unwrap();
  const entities = Array.from({ length: 9 }, (_, index) => {
    const mesh = assets.create(createBoxGeometry(1 + index / 10, 1, 1).unwrap()).unwrap();
    return world
      .spawn(
        { component: Transform, data: { pos: [0, 0, index === 0 ? 0 : 8] } },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
  });
  const errors: unknown[] = [];
  renderer.onError((error) => errors.push(error));
  try {
    const phaseStarted = profiler.startCapture({
      frameLimit: 1,
      eventLimit: 2048,
      detail: 'passes',
    });
    if (!phaseStarted.ok) throw phaseStarted.error;
    for (let frame = 0; frame < 3; frame++) {
      world.update().unwrap();
      const drawn = renderer.draw({
        leases: [attached],
        camera: { lease: attached },
        environment: { lease: attached },
      });
      if (!drawn.ok) throw drawn.error;
    }
    expect(errors).toEqual([]);
    const phaseCapture = profiler.latestCapture();
    expect(phaseCapture?.completeness.status).toBe('complete');
    expect(
      phaseCapture?.records.some(
        (row) => row.kind === 'phase' && row.phase.endsWith('/groups/key'),
      ),
    ).toBe(false);
    expect(
      phaseCapture?.records.some(
        (row) => row.kind === 'phase' && row.phase === 'record/gpu-driven-prepare',
      ),
    ).toBe(true);
    expect(renderer.inspect().frame.frameId).toBeGreaterThanOrEqual(3);
    const first = renderer.inspect().renderScene;
    expect(first.gpuDriven.batchCount).toBe(9);
    expect(first.gpuDriven.indirectDrawCount).toBe(9);
    // Off-screen singleton batches keep their commands: the GPU cull, not a
    // per-frame CPU camera classification, rejects their instance.
    expect(first.gpuDriven.encodedIndirectDraws).toBe(18);
    // A rapid camera reversal reuses the same admitted plan and sees the
    // eight formerly hidden meshes in this frame, with no history delay and
    // without re-encoding a single command.
    world.set(camera, Transform, { pos: [0, 0, 4], quat: [0, 1, 0, 0] }).unwrap();
    world.update().unwrap();
    const reversedDraw = renderer.draw({
      leases: [attached],
      camera: { lease: attached },
      environment: { lease: attached },
    });
    if (!reversedDraw.ok) throw reversedDraw.error;
    const reversed = renderer.inspect().renderScene;
    expect(reversed.gpuDriven.batchCount).toBe(9);
    expect(reversed.gpuDriven.encodedIndirectDraws).toBe(18);
    expect(reversed.gpuDriven.preparedBundleBuilds).toBe(first.gpuDriven.preparedBundleBuilds);
    expect(reversed.gpuDriven.preparedBundleHits).toBeGreaterThan(
      first.gpuDriven.preparedBundleHits ?? 0,
    );
    expect(reversed.fullRebuilds).toBe(first.fullRebuilds);
    expect(entities).toHaveLength(9);
  } finally {
    await renderer.dispose();
  }
});

it('re-encodes in proportion to edited batches, not to the batch count', async () => {
  const source = renderLifecycleManifestUrl();
  const manifest = JSON.parse(decodeURIComponent(source.slice(source.indexOf(',') + 1)));
  for (const entry of manifest.materialShaders) {
    if (entry.identifier !== 'forgeax::default-standard-pbr') continue;
    entry.composedWgsl += '\nfn vs_temporal() {}\nfn fs_temporal() {}\n';
    entry.receipt = createStandardPbrArtifactReceipt(false, false);
    for (const variant of entry.variants) {
      variant.composedWgsl = entry.composedWgsl;
      variant.receipt = createStandardPbrArtifactReceipt(
        false,
        variant.defines.VERTEX_COLOR_AVAILABLE === true,
      );
    }
  }
  const encodes: number[] = [];
  const recorded = vi.spyOn(IndirectPassBindings.prototype, 'recordBundle');
  for (const count of [64, 512]) {
    const renderer = await createRenderer(
      { width: 64, height: 64, getContext: () => null },
      {},
      {
        shaderManifestUrl: `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`,
      },
      {
        rhi,
        createShaderModule: async (device, descriptor) =>
          rhi.createShaderModule(device, descriptor),
      },
    );
    const initialized = await renderer.initialization;
    if (!initialized.ok) throw initialized.error;
    const assets = renderer.assetRegistry;
    const world = new World({ assets });
    const attachedResult = renderer.attach(world);
    if (!attachedResult.ok) throw attachedResult.error;
    const attached = attachedResult.value;
    registerPropagateTransforms(world);
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 40] } },
        { component: Camera, data: { fov: 1, aspect: 1, near: 0.1, far: 100 } },
      )
      .unwrap();
    const material = assets.create(Materials.standard({ baseColor: [1, 1, 1, 1] })).unwrap();
    const box = (index: number) =>
      assets.create(createBoxGeometry(1 + index / 4096, 1, 1).unwrap()).unwrap();
    // Distinct meshes keep every entity in its own batch.
    const entities = Array.from({ length: count }, (_, index) =>
      world
        .spawn(
          { component: Transform, data: { pos: [(index % 32) - 16, Math.floor(index / 32), 0] } },
          { component: MeshFilter, data: { assetHandle: box(index) } },
          { component: MeshRenderer, data: { materials: [material] } },
        )
        .unwrap(),
    );
    const draw = () => {
      world.update().unwrap();
      const drawn = renderer.draw({
        leases: [attached],
        camera: { lease: attached },
        environment: { lease: attached },
      });
      if (!drawn.ok) throw drawn.error;
    };
    try {
      for (let frame = 0; frame < 3; frame++) draw();
      expect(renderer.inspect().renderScene.gpuDriven.batchCount).toBe(count);
      recorded.mockClear();
      // Each steady frame replaces the geometry of two entities.
      for (let frame = 0; frame < 4; frame++) {
        for (const index of [frame * 7, frame * 7 + count / 2]) {
          world
            .set(entities[index] as EntityHandle, MeshFilter, {
              assetHandle: box(count + frame * 2 + index),
            })
            .unwrap();
        }
        draw();
      }
      expect(renderer.inspect().renderScene.gpuDriven.batchCount).toBe(count);
      encodes.push(recorded.mock.calls.length);
    } finally {
      await renderer.dispose();
    }
  }
  recorded.mockRestore();
  // Only the stable-ID blocks holding an edited batch re-encode; every other
  // block replays its retained bundle without visiting its batches.
  expect(encodes[0]).toBeGreaterThan(0);
  expect(encodes[1]).toBe(encodes[0]);
});
