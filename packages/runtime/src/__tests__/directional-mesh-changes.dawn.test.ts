import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { RhiError } from '@forgeax/engine-rhi';
import { Transform } from '@forgeax/engine-scene';
import { assert, expect, it, onTestFinished, vi } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { constructRendererHost } from '../../../render/src/construct-renderer';
import { GpuResidencyCache } from '../../../render/src/device/gpu-residency';
import { MeshChanges, ShadowMeshReads } from '../../../render/src/device/mesh-changes';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
} from '../../../render/src/index';
import { installDefaultAssetDecoders } from '../asset-contributions';
import { loadBackendPack } from '../backend-selection';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

const manifest = await (
  await import('@forgeax/engine-vite-plugin-shader')
).buildEngineShaderManifest();
const manifestUrl = shaderManifestUrl(manifest);

it('retains native Frame Mesh dependencies and advances unrelated-change cursors only on accepted submit', async () => {
  let target: GPUTexture | undefined;
  let device: GPUDevice | undefined;
  const canvas = {
    width: 64,
    height: 64,
    getContext: () => ({
      configure(config: GPUCanvasConfiguration) {
        device = config.device;
        target?.destroy();
        target = device.createTexture({
          size: [64, 64],
          format: config.format,
          viewFormats: [config.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });
      },
      unconfigure() {},
      getCurrentTexture: () => target,
    }),
    addEventListener() {},
    removeEventListener() {},
  };
  const configure = vi.spyOn(GpuResidencyCache.prototype, 'configureGpuDevice');
  const getMesh = vi.spyOn(GpuResidencyCache.prototype, 'getMeshGpuHandles');
  const add = vi.spyOn(ShadowMeshReads.prototype, 'add');
  const retain = vi.spyOn(ShadowMeshReads.prototype, 'retain');
  const changed = vi.spyOn(MeshChanges.prototype, 'query');
  onTestFinished(() => {
    configure.mockRestore();
    getMesh.mockRestore();
    add.mockRestore();
    retain.mockRestore();
    changed.mockRestore();
  });
  let reject = false;
  let rejectedSubmissions = 0;
  const fault = new RhiError({
    code: 'webgpu-runtime-error',
    expected: 'accepted test submission',
    hint: 'retry after the deliberate submit rejection',
  });
  // Observe private Frame ownership in one source module graph; Runtime still
  // supplies the real native backend and its ordinary decoder assembly.
  const backend = await loadBackendPack({
    rhiInstrumentation: {
      beforeSubmit: () => {
        if (!reject) return undefined;
        rejectedSubmissions++;
        return fault;
      },
    },
  });
  assert(backend.ok);
  const constructed = await constructRendererHost(
    canvas,
    {},
    { shaderManifestUrl: manifestUrl },
    backend.value,
  );
  assert(constructed.ok, constructed.ok ? undefined : JSON.stringify(constructed.error));
  const { renderer, assets } = constructed.value;
  const errors: unknown[] = [];
  const stop = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  let validationScope = false;
  try {
    installDefaultAssetDecoders(assets);
    const world = new World({ assets });
    const mesh = createBoxGeometry(1, 1, 1).unwrap();
    const handle = assets.create(mesh).unwrap();
    const material = assets.create(Materials.standard({ baseColor: [0.8, 0.2, 0.1, 1] })).unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [0, 2, 6] } },
        {
          component: Camera,
          data: { fov: Math.PI / 3, aspect: 1, near: 0.1, far: 60, antialias: 0, bloom: 0 },
        },
      )
      .unwrap();
    world
      .spawn({
        component: DirectionalLight,
        data: {
          direction: [-0.5, -0.8, -1],
          castShadow: true,
          mapSize: 64,
          cascadeCount: 1,
          shadowDistance: 30,
        },
      })
      .unwrap();
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: handle } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    const attached = renderer.attach(world);
    assert(attached.ok);
    const lease = attached.value;
    const draw = async () => {
      world.update(1 / 60).unwrap();
      return drawReadyFrame(renderer, {
        leases: [lease],
        camera: { lease },
        environment: { lease },
        geometryLane: 'direct',
      });
    };
    await draw();
    assert(device);
    device.pushErrorScope('validation');
    validationScope = true;
    await draw();
    const root = retain.mock.contexts.at(-1);
    assert(root instanceof ShadowMeshReads, 'production Frame must borrow an accepted Mesh root');
    const store = configure.mock.contexts.find(
      (value): value is GpuResidencyCache =>
        value instanceof GpuResidencyCache && value.meshChanges === root.changes,
    );
    assert(store);
    expect(root.fixed).toBe(true);
    expect(root.tokens.size).toBeGreaterThan(0);
    const captures = add.mock.calls.length;
    for (let frame = 0; frame < 60; frame++) await draw();
    expect(add.mock.calls.length).toBe(captures);
    expect(retain.mock.contexts.at(-1)).toBe(root);
    expect(
      renderer
        .inspect()
        .shadowRaster.views.some(
          (view) => view.identity.kind === 'directional' && view.cache === 'hit',
        ),
    ).toBe(true);
    const accepted = root.changes.epoch;
    const other = createBoxGeometry(2, 3, 4).unwrap();
    const otherHandle = assets.create(other).unwrap();
    store.ensureResident(otherHandle, other).unwrap();
    const upper = root.changes.epoch;
    expect(upper).toBeGreaterThan(accepted);
    expect(errors).toEqual([]);
    changed.mockClear();
    reject = true;
    await expect(draw()).rejects.toMatchObject({ code: 'frame-submit-rejected' });
    expect(changed.mock.calls.some((call) => call[0] === accepted && call[2] === root.tokens)).toBe(
      true,
    );
    reject = false;
    expect(rejectedSubmissions).toBe(1);
    expect(errors).toMatchObject([
      {
        code: 'device-operation-failed',
        detail: {
          operation: 'renderer-event',
          cause: { code: fault.code, expected: fault.expected, hint: fault.hint },
        },
      },
    ]);
    // The failed hit cannot accept its prepared upper bound.
    changed.mockClear();
    await draw();
    expect(changed.mock.calls.some((call) => call[0] === accepted && call[2] === root.tokens)).toBe(
      true,
    );
    expect(retain.mock.contexts.at(-1)).toBe(root);
    changed.mockClear();
    await draw();
    expect(changed.mock.calls.some((call) => call[0] === upper && call[2] === root.tokens)).toBe(
      true,
    );
    expect(add.mock.calls.length).toBe(captures);
    const unrelatedRaster = renderer
      .inspect()
      .shadowRaster.views.filter((view) => view.identity.kind === 'directional');
    expect(unrelatedRaster.length).toBeGreaterThan(0);
    expect(unrelatedRaster.every((view) => view.cache === 'hit' && view.drawCount === 0)).toBe(
      true,
    );
    // Use the namespace read by the real Frame, rather than guessing a World id.
    const physicalCall = getMesh.mock.calls.find((call, index) => {
      const result = getMesh.mock.results[index];
      return (
        call[0] === handle &&
        result?.type === 'return' &&
        result.value?.changeToken !== undefined &&
        root.tokens.has(result.value.changeToken)
      );
    });
    assert(physicalCall, 'the actual depth dependency must have a physical residency lookup');
    const physical = store.getMeshGpuHandles(handle, physicalCall[1]);
    assert(physical);
    const physicalToken = physical.changeToken;
    const position = mesh.attributes.position;
    assert(position instanceof Float32Array);
    const [x, y, z] = position;
    assert(x !== undefined && y !== undefined && z !== undefined);
    assets
      .writeRange(handle, {
        attribute: 'position',
        first: 0,
        values: Float32Array.of(x + 0.2, y, z),
      })
      .unwrap();
    changed.mockClear();
    reject = true;
    await expect(draw()).rejects.toMatchObject({ code: 'frame-submit-rejected' });
    reject = false;
    expect(add.mock.calls.length).toBe(captures);
    expect(changed.mock.calls.some((call) => call[0] === upper && call[2] === root.tokens)).toBe(
      true,
    );
    changed.mockClear();
    await draw();
    expect(changed.mock.calls.some((call) => call[0] === upper && call[2] === root.tokens)).toBe(
      true,
    );
    expect(add.mock.calls.length).toBe(captures);
    expect(root.fixed).toBe(true);
    expect(store.getMeshGpuHandles(handle, physicalCall[1])).toBe(physical);
    expect(physical.changeToken).toBe(physicalToken);
    const raster = renderer
      .inspect()
      .shadowRaster.views.filter((view) => view.identity.kind === 'directional');
    expect(raster.length).toBeGreaterThan(0);
    expect(
      raster.every(
        (view) =>
          view.cache === 'miss' &&
          view.invalidationReason === 'content-changed' &&
          view.drawCount > 0,
      ),
    ).toBe(true);
    await draw();
    expect(retain.mock.contexts.at(-1)).toBe(root);
    const settled = renderer
      .inspect()
      .shadowRaster.views.filter((view) => view.identity.kind === 'directional');
    expect(settled.length).toBe(raster.length);
    expect(settled.every((view) => view.cache === 'hit' && view.drawCount === 0)).toBe(true);
    store.invalidateMesh(handle, physicalCall[1]);
    await draw();
    expect(add.mock.calls.length).toBeGreaterThan(captures);
    expect(root.fixed).toBe(false); // All candidate borrowers released before recollection.
    const replaced = renderer
      .inspect()
      .shadowRaster.views.filter((view) => view.identity.kind === 'directional');
    expect(replaced.every((view) => view.cache === 'miss' && view.drawCount > 0)).toBe(true);
    await draw();
    expect(Object.is(retain.mock.contexts.at(-1), root)).toBe(false);
    const validation = await device.popErrorScope();
    validationScope = false;
    expect(validation).toBeNull();
    // Only the two deliberate submission rejections may reach the public facade.
    expect(errors).toHaveLength(2);
    expect(rejectedSubmissions).toBe(2);
    expect(errors[1]).toMatchObject({
      code: 'device-operation-failed',
      detail: {
        operation: 'renderer-event',
        cause: { code: fault.code, expected: fault.expected, hint: fault.hint },
      },
    });
  } finally {
    reject = false;
    stop();
    try {
      if (validationScope) expect(await device?.popErrorScope()).toBeNull();
    } finally {
      try {
        expect((await renderer.dispose()).ok).toBe(true);
      } finally {
        target?.destroy();
        assets.dispose();
      }
    }
  }
}, 120_000);
