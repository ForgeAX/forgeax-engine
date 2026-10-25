import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  Camera,
  createRenderPublisher,
  Materials,
  MeshFilter,
  MeshRenderer,
  PointLight,
  type RenderResult,
  renderPublicationTransfers,
  VolumetricFog,
  VolumetricFogSamplingValue,
} from '@forgeax/engine-render';
import { attachRecorder, buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { completeReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { constructRuntimeRendererHost } from '../renderer-host';
import { luminanceRgba16f } from './contact-shadow.fixture';
import { testAssets } from './helpers/runtime-assets';
import { collectWebGpuValidationErrors } from './webgpu-validation.fixture';

function value<T>(result: RenderResult<T, unknown> | undefined): T {
  if (result === undefined) throw new Error('required renderer operation unavailable');
  if (!result.ok) throw result.error;
  return result.value;
}
function required<T>(input: T | undefined): T {
  if (input === undefined) throw new Error('missing point-decay fixture value');
  return input;
}
async function save(name: string, bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  await commands.writeFile(
    `artifacts/pr-evidence/point-light-decay/${name}`,
    btoa(binary),
    'base64',
  );
}

it.each([
  ['world', 'forward'],
  ['world', 'deferred'],
  ['publication', 'forward'],
  ['publication', 'deferred'],
  ['volume', 'forward'],
  ['volume', 'deferred'],
] as const)(
  'projects live point decay through %s / %s',
  { timeout: 180_000 },
  async (mode, renderPath) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    document.body.append(canvas);
    const recorder = attachRecorder(webgpu).unwrap();
    const identity = { source: 'point-decay', epoch: 1 };
    const validation = collectWebGpuValidationErrors();
    const { renderer, assets } = value(
      await constructRuntimeRendererHost(
        canvas,
        {
          rhi: recorder.backend.rhi,
          ...(mode === 'publication' ? { publicationSource: identity } : {}),
          rhiInstrumentation: {
            resolveSurfaceDevice: recorder.backend.unwrapDeviceForSurface,
          },
        },
        { shaderManifestUrl: '/shaders/manifest.json' },
      ),
    );
    value(renderer.setProfile({ ...renderer.inspect().profile, renderPath, ibl: false }));
    const errors: unknown[] = [];
    const off = renderer.subscribe((event) => {
      if (event.kind === 'error') errors.push(event.error);
    });
    const world = new World({ assets });
    const mesh = testAssets(world)
      .create(createBoxGeometry(2, 2, 0.1).unwrap())
      .unwrap();
    const material = testAssets(world)
      .create(
        mode === 'volume'
          ? Materials.unlit([0, 0, 0, 1])
          : Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1], roughness: 1, metallic: 0 }),
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, -4] } },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: {} },
        {
          component: Camera,
          data: {
            fov: Math.PI / 3,
            aspect: 1,
            near: 0.1,
            far: 20,
            tonemap: 0,
            antialias: 0,
            bloom: 0,
            clearColor: [0, 0, 0, 1],
          },
        },
      )
      .unwrap();
    const point = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, mode === 'volume' ? 0 : -2] } },
        { component: PointLight, data: { intensity: 2, range: 15 } },
      )
      .unwrap();
    const density =
      mode === 'volume'
        ? testAssets(world)
            .create({
              kind: 'texture',
              shape: { viewDimension: '3d', extent: { width: 2, height: 2, depth: 2 } },
              format: 'rgba8unorm',
              colorSpace: 'linear',
              mips: { kind: 'none' },
              data: new Uint8Array(32).fill(255),
            })
            .unwrap()
        : undefined;
    if (density !== undefined)
      world
        .spawn({
          component: VolumetricFog,
          data: {
            light: point,
            density,
            sampling: VolumetricFogSamplingValue.densityAlbedo,
            boundsMin: [-1, -1, -3],
            boundsMax: [1, 1, -2.5],
            extinction: [0.8, 0.8, 0.8],
            albedo: [1, 1, 1],
            anisotropy: 0,
            maxDistance: 10,
          },
        })
        .unwrap();
    const publisher =
      mode === 'publication'
        ? createRenderPublisher(world, assets, identity, renderer.inspect().capabilities)
        : undefined;
    const lease = publisher === undefined ? value(renderer.attach(world)) : undefined;
    let frames = 0;
    const draw = async (observe: boolean) => {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      const pending = observe ? recorder.captureFrame() : undefined;
      if (pending) (await recorder.frameBoundary()).unwrap();
      const receipt = await completeReadyFrame(async () => {
        if (observe || mode === 'volume') value(renderer.requestObservation?.(['linear-hdr']));
        const prepared = publisher?.prepare((frames + 1) / 60).unwrap();
        const packet =
          prepared === undefined
            ? undefined
            : structuredClone(prepared.message, {
                transfer: renderPublicationTransfers(prepared.message),
              });
        prepared?.accept();
        try {
          const receipt = value(
            renderer.draw(
              packet
                ? { publication: packet }
                : {
                    leases: [required(lease)],
                    camera: { lease: required(lease) },
                    environment: { lease: required(lease) },
                  },
            ),
          );
          value(await receipt.completed);
          return receipt;
        } finally {
          if (packet)
            required(publisher)
              .recycle(packet.revision, renderPublicationTransfers(packet))
              .unwrap();
        }
      });
      frames++;
      if (!pending) {
        if (mode === 'volume') value(await renderer.observe(receipt, { include: ['linear-hdr'] }));
        return undefined;
      }
      (await recorder.frameBoundary()).unwrap();
      const tape = (await pending).unwrap();
      const decoded = decodeTape(tape.bytes).unwrap();
      const model = buildFrameModel(decoded);
      let history: number | undefined;
      if (mode === 'volume') {
        const work = required(
          model.works.find((work) =>
            work.pipeline.shaders.some((shader) => shader.entryPoint === 'volume_temporal'),
          ),
        );
        const binding = required(
          work.bindings.find((binding) => binding.groupIndex === 0 && binding.binding === 3),
        );
        const offset = (binding.bufferOffset ?? 0) + (binding.dynamicOffset ?? 0) + 31 * 4;
        const scalar = (hash: string, start: number, size: number) => {
          if (start <= offset && start + size >= offset + 4) {
            const bytes = required(decoded.blobs.find((blob) => blob.hash === hash)).bytes;
            history = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(
              offset - start,
              true,
            );
          }
        };
        for (const slice of decoded.bootstrap.find(
          (resource) => resource.handleId === binding.resourceId,
        )?.initialData ?? [])
          scalar(slice.hash, slice.byteOffset, slice.byteLength);
        for (const event of decoded.events.slice(0, work.eventIndex)) {
          if (event.kind === 'writeBuffer' && event.handleId === binding.resourceId)
            scalar(event.dataHash, event.bufferOffset, event.size);
        }
      }
      const observation = required(
        value(await renderer.observe(receipt, { include: ['linear-hdr'] })).observations?.find(
          (row) => row.domain === 'linear-hdr',
        ),
      );
      const pixels = luminanceRgba16f(observation.bytes, 64, 64, observation.metadata.bytesPerRow);
      const luminance =
        ((pixels[31 * 64 + 31] ?? 0) +
          (pixels[31 * 64 + 32] ?? 0) +
          (pixels[32 * 64 + 31] ?? 0) +
          (pixels[32 * 64 + 32] ?? 0)) /
        4;
      await save(`${mode}-${renderPath}-${frames}.rhitape`, tape.bytes);
      return {
        luminance,
        history,
        frames,
        digest: tape.digest,
        works: model.works.map((work) => ({
          workIndex: work.workIndex,
          shaders: work.pipeline.shaders.map((shader) => shader.entryPoint),
          bindings: work.bindings,
        })),
        unseededResources: model.unseededResources,
      };
    };
    try {
      const samples = [];
      const transitionHistory: (number | undefined)[] = [];
      for (const decay of [2, 1.4, 0, 4, 2]) {
        world.set(point, PointLight, { decay }).unwrap();
        if (mode === 'volume') transitionHistory.push(required(await draw(true)).history);
        for (let i = 0; i < (mode === 'volume' ? 10 : 11); i++) await draw(false);
        samples.push({ decay, ...required(await draw(true)) });
      }
      await commands.writeFile(
        `artifacts/pr-evidence/point-light-decay/${mode}-${renderPath}.json`,
        JSON.stringify({ samples, transitionHistory, validation, errors }, null, 2),
      );
      const baseline = required(samples[0]).luminance;
      expect(baseline).toBeGreaterThan(0.03);
      // Four central pixels hit the same planar front face at z=-3.95.
      const distance = Math.hypot(
        1.95,
        (3.95 * Math.tan(Math.PI / 6)) / 64,
        (3.95 * Math.tan(Math.PI / 6)) / 64,
      );
      for (const sample of samples) {
        if (mode === 'volume') {
          // Every central-ray volume sample is between 2.5 and 3.1m from the point.
          // Positive integration weights keep the ratio within the power-law bounds.
          const bounds = [2.5 ** (2 - sample.decay), 3.1 ** (2 - sample.decay)].sort(
            (a, b) => a - b,
          );
          expect(sample.luminance / baseline).toBeGreaterThanOrEqual(required(bounds[0]) - 0.01);
          expect(sample.luminance / baseline).toBeLessThanOrEqual(required(bounds[1]) + 0.01);
          expect(sample.history).toBe(1);
        } else {
          const expected = distance ** (2 - sample.decay);
          expect(Math.abs(sample.luminance / baseline - expected)).toBeLessThan(0.01);
        }
      }
      if (mode === 'volume') expect(transitionHistory).toEqual([0, 0, 0, 0, 0]);
      expect(frames).toBe(60);
      expect(validation).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      off();
      publisher?.dispose();
      testAssets(world).release(mesh).unwrap();
      testAssets(world).release(material).unwrap();
      if (density !== undefined) testAssets(world).release(density).unwrap();
      value(await renderer.dispose());
      (await recorder.dispose()).unwrap();
      canvas.remove();
    }
  },
);
