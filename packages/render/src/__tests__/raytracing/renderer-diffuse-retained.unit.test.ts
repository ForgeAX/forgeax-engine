import { RhiError } from '@forgeax/engine-rhi';
import * as nullRhi from '@forgeax/engine-rhi-null';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { err } from '@forgeax/engine-types';
import { assert, expect, it, vi } from 'vitest';
import { DeviceScope } from '../../device/device-scope';
import type { StandardExactDiffuseGi } from '../../pipeline/standard-profile';
import { worldRenderResources } from '../../publication/resource-scope';
import { RendererRayDiffuse } from '../../raytracing/renderer-diffuse';
import { VisibleSurfaceRows } from '../../raytracing/visible-surface';
import type { RenderSystemInternals } from '../../record/render-context';
import { MaterialFrame } from '../../scene/material-dispatch';
import { MeshFrame } from '../../scene/mesh-frame';
import type { PersistentGpuDrivenState } from '../../scene/render-scene';
import { prepareRayPublicationFixture } from './path-tracer.commands';
import { retainedTransportPlane } from './scene-projection.fixture';

// Structural owner/fence evidence uses Null and real cooked material admission.
// Browser/Dawn remain responsible for shader validation and the resulting pixels.
it('retains reference diffuse allocations on a row refit and fences stale frame commits', async () => {
  const fixture = await prepareRayPublicationFixture('white');
  const device = (await (await nullRhi.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shaders = new ShaderRegistry({ manifestUrl: undefined });
  shaders.installMaterialArtifact('fixture::ray', {
    source: fixture.material.program.wgsl,
    paramSchema: fixture.material.program.paramSchema,
  });
  vi.spyOn(shaders, 'entries').mockImplementation(
    () =>
      [{ wgsl: 'fn generateRasterRays() {} fn fs_ray_diffuse() {} fn reconstructDiffuse() {}' }][
        Symbol.iterator
      ]() as ReturnType<ShaderRegistry['entries']>,
  );
  vi.spyOn(shaders, 'materialShaderManifestEntries').mockImplementation(
    () =>
      [
        {
          identifier: 'forgeax::engine-ray-path-tracer',
          variants: [
            { defines: { DIRECT_DFG_LUT_AVAILABLE: false }, composedWgsl: fixture.kernel },
          ],
        },
      ][Symbol.iterator]() as ReturnType<ShaderRegistry['materialShaderManifestEntries']>,
  );
  const source = retainedTransportPlane({ kind: 'material' });
  const material = source.retained.slotsSnapshot().at(0)?.snapshot.material;
  assert(material);
  material.adopt({
    ...material.snapshot,
    materialSurfacePrograms: { 'ray-hit': { programKey: 'fixture::ray', evaluateCoverage: false } },
  });
  const profile: StandardExactDiffuseGi = {
    gather: 'exact',
    maxBounces: 2,
    seed: 17,
    maxDistance: 100,
    environment: [1, 1, 1],
    reconstruction: 'temporal',
  };
  const compile = vi.fn(nullRhi.createShaderModule);
  const runtime = {
    device,
    shaderRegistry: shaders,
    createShaderModule: compile,
    deviceScope: DeviceScope.create(0, 'retained-diffuse-test'),
    standardProfile: { diffuseGi: profile },
    errorRegistry: { fire: vi.fn() },
  } as unknown as RenderSystemInternals;
  const renderer = new RendererRayDiffuse();
  let identity = {};
  const scene = {};
  const meshes = new MeshFrame();
  const materials = new MaterialFrame(undefined).withAccepted({
    resource: material,
    snapshot: material.snapshot,
    passes: [],
    bindings: 1,
  });
  const surfaces = new VisibleSurfaceRows();
  const worlds = [worldRenderResources(source.world)];
  const sampler = device.createSampler({}).unwrap();
  let revision = 0;
  const prepare = () => {
    const slots = source.retained.slotsSnapshot();
    const retained = {
      identity,
      revision: ++revision,
      slots,
      materials,
      meshes,
      worlds,
      isCurrent: () => true,
      isSourceCurrent: () => true,
    };
    renderer.prepare({
      runtime,
      scene: { scene, slots, retained } as unknown as PersistentGpuDrivenState,
      worlds,
      sampler,
      lights: [],
      profile,
      visibleSurface: surfaces.update(retained, 64).unwrap(),
      width: 8,
      height: 8,
    });
  };
  prepare();
  await vi.waitFor(() => expect(renderer.ready).toBeDefined());
  const first = renderer.ready;
  assert(first);
  first.commit();
  expect(renderer.inspect().submittedFrames).toBe(1);
  const allocate = vi.spyOn(device, 'createBuffer');
  compile.mockClear();
  source.update(30);
  prepare();
  const next = renderer.ready;
  assert(next);
  expect(next.generation).toBeGreaterThan(first.generation);
  expect(next.transport).toBe(first.transport);
  expect(next.records).toBe(first.records);
  expect(allocate).not.toHaveBeenCalled();
  expect(compile).not.toHaveBeenCalled();
  expect(first.fence.currentGeneration()).toBe(-1);
  expect(next.reconstruction?.inspect().resetReason).toBe('content-generation');
  first.commit();
  expect(renderer.inspect().submittedFrames).toBe(0);
  next.commit();
  expect(renderer.inspect().submittedFrames).toBe(1);
  const upload = vi.spyOn(device.queue, 'writeBuffer');
  upload.mockReturnValueOnce(
    err(
      new RhiError({
        code: 'rhi-not-available',
        expected: 'injected upload failure',
        hint: 'retry the repaired source',
      }),
    ),
  );
  source.update(40);
  prepare();
  expect(renderer.inspect()).toMatchObject({
    state: 'failed',
    error: { code: 'rhi-not-available' },
  });
  expect(renderer.ready).toBeUndefined();
  next.commit();
  expect(renderer.inspect().submittedFrames).toBe(0);
  upload.mockRestore();
  source.update(45);
  prepare();
  await vi.waitFor(() => expect(renderer.ready).toBeDefined());
  expect(renderer.ready?.transport).not.toBe(first.transport);
  source.update(50, 32);
  prepare();
  expect(renderer.ready).toBeUndefined();
  await vi.waitFor(() => expect(renderer.ready).toBeDefined());
  expect(renderer.ready?.transport).not.toBe(first.transport);
  expect(compile).toHaveBeenCalled();
  const previousIdentity = renderer.ready;
  identity = {};
  revision--; // A replacement source may restart its content revision at the same value.
  prepare();
  expect(renderer.ready).toBeUndefined();
  await vi.waitFor(() => expect(renderer.ready).toBeDefined());
  expect(renderer.ready?.transport).not.toBe(previousIdentity?.transport);
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  compile.mockImplementationOnce(async (device, descriptor) => {
    await held;
    return nullRhi.createShaderModule(device, descriptor);
  });
  source.update(60, 33);
  prepare();
  expect(renderer.ready).toBeUndefined();
  renderer.disable();
  assert(release);
  release();
  await vi.waitFor(() => {
    assert(device instanceof nullRhi.RhiNullDevice);
    expect(
      device.bookkeeper
        .allRecords()
        .filter((record) => record.kind === 'Buffer' && !record.destroyed),
    ).toHaveLength(0);
  });
  expect(renderer.ready).toBeUndefined();
  renderer.dispose();
  runtime.deviceScope.dispose();
}, 120000);
