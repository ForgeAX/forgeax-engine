import { createMaterialLoader } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack';
import {
  Camera,
  CameraView,
  CubeCamera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  PlanarReflection,
  StereoCamera,
} from '@forgeax/engine-render';
import { RhiError } from '@forgeax/engine-rhi';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { assert, expect, it } from 'vitest';
import { rayPathCommands } from '../../../render/src/__tests__/raytracing/path-tracer.commands';
import { constructRuntimeRendererHost } from '../renderer-host';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

const manifest = shaderManifestUrl(await buildEngineShaderManifest());

it('runs persistent placement through the ordinary Renderer without changing HDR or sharing cached A/B roles', async () => {
  const fixture = await rayPathCommands.prepareRayPublicationFixture(undefined, 'matte');
  const errors: unknown[] = [];
  const rendererErrors: unknown[] = [];
  const buffers = new Map<string, GPUBuffer>();
  const destroyed = new Set<GPUBuffer>();
  const roles: { accepted: GPUBuffer; candidate: GPUBuffer }[] = [];
  let native!: GPUDevice;
  let surface: GPUTexture | undefined;
  let rejectSubmit = false;
  let afterPhysicalSubmit: (() => void) | undefined;
  let loseDevice!: () => void;
  const canvas = {
    width: 32,
    height: 32,
    getContext: () => ({
      configure(config: GPUCanvasConfiguration) {
        native = config.device;
        native.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
        const queueSubmit = native.queue.submit.bind(native.queue);
        native.queue.submit = (commands) => {
          queueSubmit(commands);
          const publish = afterPhysicalSubmit;
          afterPhysicalSubmit = undefined;
          publish?.();
        };
        const create = native.createBuffer.bind(native);
        native.createBuffer = (desc) => {
          const buffer = create(desc);
          if (desc.label?.startsWith('probe-placement.')) {
            buffers.set(desc.label, buffer);
            const destroy = buffer.destroy.bind(buffer);
            buffer.destroy = () => {
              destroyed.add(buffer);
              destroy();
            };
          }
          return buffer;
        };
        const bind = native.createBindGroup.bind(native);
        native.createBindGroup = (desc) => {
          const entries = [...desc.entries];
          const acceptedResource = entries.find((entry) => entry.binding === 6)?.resource;
          const candidateResource = entries.find((entry) => entry.binding === 7)?.resource;
          const accepted =
            acceptedResource && 'buffer' in acceptedResource ? acceptedResource.buffer : undefined;
          const candidate =
            candidateResource && 'buffer' in candidateResource
              ? candidateResource.buffer
              : undefined;
          if (accepted?.label.startsWith('probe-placement.state-') && candidate)
            roles.push({ accepted, candidate });
          return bind(desc);
        };
        surface?.destroy();
        surface = native.createTexture({
          size: [canvas.width, canvas.height],
          format: config.format,
          viewFormats: [config.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
          usage: 0x11,
        });
      },
      unconfigure() {},
      getCurrentTexture: () => surface,
    }),
  };
  const host = renderValue(
    await constructRuntimeRendererHost(
      canvas,
      {
        rhi: webgpu.rhi,
        rhiInstrumentation: {
          beforeSubmit: () => {
            if (!rejectSubmit) return undefined;
            rejectSubmit = false;
            return new RhiError({
              code: 'queue-submit-failed',
              expected: 'injected placement submission failure',
              hint: 'retry the frame',
            });
          },
          deviceLost: () =>
            new Promise((resolve) => {
              loseDevice = () =>
                resolve({ reason: 'unknown', message: 'placement recovery fixture' });
            }),
        },
      },
      { shaderManifestUrl: manifest },
    ),
  );
  const { renderer, assets } = host;
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') rendererErrors.push(event.error);
  });
  const world = new World();
  const material = fixture.material;
  assert(material.name === 'matte');
  const record = validateCookedMaterialRecord(
    JSON.parse(material.cookedPublication.record),
  ).unwrap();
  const ready = await createMaterialLoader({
    loadPublication: async () => ({
      guid: 'matte',
      record,
      artifacts: Object.fromEntries(
        Object.entries(material.cookedPublication.artifacts).map(([path, bytes]) => [
          path,
          { bytes: new TextEncoder().encode(bytes) },
        ]),
      ),
    }),
  }).load({ guid: 'matte', specializationKey: record.specializationKey ?? '' });
  assert(
    ready.status === 'Ready',
    ready.status === 'Error' ? JSON.stringify(ready.error) : undefined,
  );
  assets.catalog('matte', material.asset).unwrap();
  assets.recordMaterialReadiness('matte', ready);
  const materialHandle = world.allocSharedRef('MaterialAsset', material.asset);
  const mesh = world.allocSharedRef('MeshAsset', createBoxGeometry(2, 2, 0.1).unwrap());
  const receiver = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, -3] } },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [materialHandle] } },
    )
    .unwrap();
  const camera = world
    .spawn(
      { component: Transform, data: {} },
      {
        component: Camera,
        data: {
          fov: Math.PI / 3,
          aspect: 1,
          near: 0.1,
          far: 50,
          antialias: 0,
          bloom: 0,
          tonemap: 0,
        },
      },
    )
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: { direction: [0, 0, -1], color: [1, 1, 1], intensity: 1, castShadow: false },
    })
    .unwrap();
  const lease = renderValue(renderer.attach(world));
  const profile = {
    ...renderer.inspect().profile,
    renderPath: 'deferred' as const,
    visibleSurface: true,
    ibl: false,
    ssao: false,
  };
  let seeds = [{ id: 7, generation: 1, position: [0, 0, -3] as const, cellSize: 2, traced: true }];
  const submit = () =>
    renderer.draw({
      leases: [lease],
      camera: { lease },
      environment: { lease },
      geometryLane: 'automatic',
    });
  const draw = async () => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    const result = submit();
    if (!result.ok)
      throw new Error(
        JSON.stringify({
          error: result.error,
          placement: renderer.inspect().probePlacement,
          errors,
          rendererErrors,
        }),
      );
    const receipt = result.value;
    renderValue(await receipt.completed);
    return receipt;
  };
  const settle = async () => {
    for (let i = 0; i < 120; i++) {
      const receipt = await draw();
      const placement = renderer.inspect().probePlacement;
      if (placement?.state === 'ready' && placement.submittedFrames > 0) return receipt;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(JSON.stringify(renderer.inspect().probePlacement));
  };
  const hdr = async () => {
    assert(renderer.requestObservation);
    renderValue(renderer.requestObservation(['linear-hdr']));
    const receipt = await draw();
    const observation = renderValue(
      await renderer.observe(receipt, { include: ['linear-hdr'] }),
    ).observations?.find((item) => item.domain === 'linear-hdr');
    assert(observation?.bytes && observation.bytes.length > 0);
    return observation.bytes;
  };
  const read = async (source: GPUBuffer) => {
    const result = native.createBuffer({ size: source.size, usage: 9 });
    try {
      const encoder = native.createCommandEncoder();
      encoder.copyBufferToBuffer(source, 0, result, 0, source.size);
      native.queue.submit([encoder.finish()]);
      await result.mapAsync(1);
      return new Uint32Array(result.getMappedRange().slice(0));
    } finally {
      result.destroy();
    }
  };
  try {
    renderValue(renderer.setProfile(profile));
    for (let i = 0; i < 8; i++) await draw();
    const baseline = await hdr();
    assert(baseline);
    expect(buffers.size).toBe(0);
    renderValue(renderer.setProfile({ ...profile, probePlacement: { seeds } }));
    await settle();
    expect(renderer.inspect().diffuseGi).toBeUndefined();
    const first = roles.at(-1);
    assert(first);
    const firstBytes = await read(first.candidate);
    expect([...firstBytes.slice(4, 6)]).toEqual([7, 1]);
    const status = buffers.get('probe-placement.status-b');
    assert(status);
    expect((await read(status))[2]).toBe(1);
    await draw();
    const second = roles.at(-1);
    assert(second);
    expect(second.accepted).toBe(first.candidate);
    expect(second.candidate).toBe(first.accepted);
    expect(await read(first.candidate)).toEqual(firstBytes);
    await draw();
    expect(roles.at(-1)?.accepted).toBe(second.candidate);
    for (let frame = 0; frame < 60; frame++) {
      const previous = roles.at(-1);
      assert(previous);
      await draw();
      expect(roles.at(-1)?.accepted).toBe(previous.candidate);
    }
    expect(await hdr()).toEqual(baseline);
    const nativeMaterial = world.allocSharedRef(
      'MaterialAsset',
      Materials.standard({ baseColor: [0.8, 0.4, 0.2, 1], roughness: 0.65, specular: 0 }),
    );
    world.set(receiver, MeshRenderer, { materials: [nativeMaterial] }).unwrap();
    await draw();
    expect(await hdr()).toEqual(baseline);
    world.set(receiver, MeshRenderer, { materials: [materialHandle] }).unwrap();
    await draw();
    const accepted = renderer.inspect().probePlacement;
    assert(accepted);
    assert(seeds[0]);
    seeds = [{ ...seeds[0], generation: 2 }];
    renderValue(renderer.setProfile({ ...profile, probePlacement: { seeds } }));
    rejectSubmit = true;
    expect(submit().ok).toBe(false);
    expect(renderer.inspect().probePlacement?.generation).toBe(accepted.generation);
    expect(destroyed.has(first.accepted)).toBe(false);
    await settle();
    expect(renderer.inspect().probePlacement?.generation).toBeGreaterThan(accepted.generation);
    expect(destroyed.has(first.accepted)).toBe(true);
    const diffuseGi = {
      gather: 'exact' as const,
      maxBounces: 1,
      maxDistance: 100,
      seed: 47,
      environment: [0.25, 0.5, 0.75] as const,
    };
    renderValue(renderer.setProfile({ ...profile, probePlacement: { seeds }, diffuseGi }));
    for (
      let frame = 0;
      frame < 120 && (renderer.inspect().diffuseGi?.submittedFrames ?? 0) === 0;
      frame++
    ) {
      await draw();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const diffuseBefore = renderer.inspect().diffuseGi;
    assert(diffuseBefore?.state === 'ready' && diffuseBefore.submittedFrames > 0);
    afterPhysicalSubmit = () => {
      assert(seeds[0]);
      seeds = [{ ...seeds[0], generation: 3 }];
      renderValue(renderer.setProfile({ ...profile, probePlacement: { seeds }, diffuseGi }));
    };
    expect(submit().ok).toBe(true);
    expect(renderer.inspect().diffuseGi).toMatchObject({
      generation: diffuseBefore.generation,
      submittedFrames: diffuseBefore.submittedFrames,
    });
    await settle();
    for (let frame = 0; frame < 120; frame++) {
      const diffuse = renderer.inspect().diffuseGi;
      if (
        diffuse?.state === 'ready' &&
        diffuse.submittedFrames >
          (diffuse.generation === diffuseBefore.generation ? diffuseBefore.submittedFrames : 0)
      )
        break;
      if (frame === 119) throw new Error(JSON.stringify({ diffuseBefore, diffuse }));
      await draw();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const active = roles.at(-1)?.candidate;
    assert(active);
    renderValue(renderer.setProfile(profile));
    await draw();
    expect(renderer.inspect().probePlacement).toBeUndefined();
    expect(destroyed.has(active)).toBe(true);
    renderValue(renderer.setProfile({ ...profile, probePlacement: { seeds } }));
    await settle();
    expect(roles.at(-1)?.candidate).not.toBe(active);
    for (const mode of ['auxiliary', 'cube', 'multi-view', 'planar', 'stereo'] as const) {
      const target = renderValue(
        renderer.createRenderTarget({
          shape: mode === 'cube' ? 'cube' : '2d',
          width: 32,
          height: 32,
          format: 'rgba8unorm',
          sampleCount: 1,
          mipLevels: 1,
          sampled: true,
          readback: false,
        }),
      );
      const targetHandle = world.allocSharedRef('RenderTarget', target);
      const extra = world.spawn({ component: Transform, data: {} }).unwrap();
      if (mode === 'cube') {
        world
          .addComponent(extra, { component: CubeCamera, data: { target: targetHandle } })
          .unwrap();
      } else if (mode === 'planar') {
        world
          .addComponent(camera, { component: PlanarReflection, data: { target: targetHandle } })
          .unwrap();
      } else if (mode === 'stereo') {
        world.addComponent(camera, { component: StereoCamera, data: {} }).unwrap();
      } else {
        world
          .addComponent(extra, {
            component: Camera,
            data: mode === 'auxiliary' ? { target: targetHandle } : {},
          })
          .unwrap();
        if (mode === 'multi-view') {
          world.addComponent(camera, { component: CameraView, data: {} }).unwrap();
          world.addComponent(extra, { component: CameraView, data: {} }).unwrap();
        }
      }
      propagateTransforms(world).unwrap();
      const placementWork = roles.length;
      const rejected = submit();
      expect(rejected.ok).toBe(false);
      expect(JSON.stringify(rejected)).toContain('probe placement');
      expect(roles.length).toBe(placementWork);
      world.despawn(extra).unwrap();
      if (mode === 'multi-view') world.removeComponent(camera, CameraView).unwrap();
      if (mode === 'planar') world.removeComponent(camera, PlanarReflection).unwrap();
      if (mode === 'stereo') world.removeComponent(camera, StereoCamera).unwrap();
      renderValue(renderer.destroyRenderTarget(target));
      await settle();
    }
    loseDevice();
    await expect.poll(() => renderer.state()).toBe('device-lost');
    renderValue(await renderer.recover());
    await settle();
    expect(renderer.inspect().probePlacement?.submittedFrames).toBeGreaterThan(0);
    expect(await hdr()).toEqual(baseline);
    expect(errors).toEqual([]);
  } finally {
    unsubscribe();
    lease.dispose();
    renderValue(await renderer.dispose());
    surface?.destroy();
  }
}, 180000);
