import { mkdirSync, writeFileSync } from 'node:fs';
import { createMaterialLoader } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
} from '@forgeax/engine-render';
import { RhiError } from '@forgeax/engine-rhi';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  encodeTape,
  openReplay,
  replayDeviceRequest,
  type V7Tape,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import type { Asset, AssetHandle } from '@forgeax/engine-types';
import { type MaterialAsset, ok } from '@forgeax/engine-types';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { assert, expect, it } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { publishRuntimeAssets } from '../../../assets-runtime/src/__tests__/fixtures/runtime-publication';
import {
  createProbeGlobalMesh,
  probeGlobalProfile,
} from '../../../render/src/__tests__/raytracing/probe-global.fixture';
import { createMaterialPackCooker } from '../../../shader-compiler/src/material/pack-cooker';
import { constructRuntimeRendererHost } from '../renderer-host';
import { testAssets } from './helpers/runtime-assets';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

const manifest = shaderManifestUrl(await buildEngineShaderManifest());
it.each([
  { nativeCards: false, geometryLane: 'automatic' as const },
  { nativeCards: true, geometryLane: 'automatic' as const },
  { nativeCards: true, geometryLane: 'direct' as const },
])('records the ordinary raster-to-Global chain with native Cards $nativeCards in $geometryLane and replays after disposal', async ({
  nativeCards,
  geometryLane,
}) => {
  const coldTexture = geometryLane === 'direct';
  const directory = coldTexture
    ? 'artifacts/probe-card-cold-mip-witness/dawn'
    : nativeCards
      ? 'artifacts/probe-card-witness/dawn'
      : 'artifacts/probe-global-witness/dawn';
  mkdirSync(directory, { recursive: true });
  const save = (name: string, bytes: Uint8Array) => writeFileSync(`${directory}/${name}`, bytes);
  const errors: string[] = [],
    rendererErrors: unknown[] = [];
  const buffers = new Map<string, GPUBuffer>();
  const cardTextures = new Map<string, GPUTexture>();
  const sourceDevices = new Set<GPUDevice>();
  let native!: GPUDevice, surface: GPUTexture | undefined;
  let failSubmit = false,
    failFinish = false;
  let afterPhysicalSubmit: (() => void) | undefined, afterExtract: (() => void) | undefined;
  let loseDevice!: () => void;
  let submitCount = 0;
  const canvas = {
    width: 32,
    height: 32,
    getContext: () => ({
      configure(config: GPUCanvasConfiguration) {
        native = config.device;
        sourceDevices.add(native);
        native.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
        const makeTexture = native.createTexture.bind(native);
        native.createTexture = (desc) => {
          const value = makeTexture(desc);
          if (desc.label?.startsWith('cards.')) cardTextures.set(desc.label, value);
          return value;
        };
        const create = native.createBuffer.bind(native);
        native.createBuffer = (desc) => {
          const buffer = create(desc);
          if (desc.label?.startsWith('probe-')) buffers.set(desc.label, buffer);
          return buffer;
        };
        const makeEncoder = native.createCommandEncoder.bind(native);
        native.createCommandEncoder = (desc) => {
          const encoder = makeEncoder(desc),
            finish = encoder.finish.bind(encoder);
          encoder.finish = (options) => {
            if (failFinish) {
              failFinish = false;
              throw new Error('injected Global encoder finish failure');
            }
            return finish(options);
          };
          return encoder;
        };
        const submit = native.queue.submit.bind(native.queue);
        native.queue.submit = (commands) => {
          submitCount++;
          submit(commands);
          const action = afterPhysicalSubmit;
          afterPhysicalSubmit = undefined;
          action?.();
        };
        surface?.destroy();
        surface = native.createTexture({
          size: [32, 32],
          format: config.format,
          usage: 0x11,
          viewFormats: [config.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
        });
      },
      unconfigure() {},
      getCurrentTexture: () => surface,
    }),
  };
  const recorder = attachRecorder(webgpu).unwrap();
  const host = renderValue(
    await constructRuntimeRendererHost(
      canvas,
      {
        rhi: recorder.backend.rhi,
        features: [
          {
            identity: 'probe-global.source-fence-fixture',
            extract: () => {
              const action = afterExtract;
              afterExtract = undefined;
              action?.();
              return ok(undefined);
            },
            plan: () => ok({ work: [] }),
          },
        ],
        rhiInstrumentation: {
          beforeSubmit: () => {
            if (!failSubmit) return undefined;
            failSubmit = false;
            return new RhiError({
              code: 'queue-submit-failed',
              expected: 'injected Global submit failure',
              hint: 'retry the same frame',
            });
          },
          deviceLost: () =>
            new Promise((resolve) => {
              loseDevice = () => resolve({ reason: 'unknown', message: 'Global recovery fixture' });
            }),
        },
      },
      { shaderManifestUrl: manifest },
    ),
  );
  const { renderer } = host;
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') rendererErrors.push(event.error);
  });
  const world = new World({ assets: host.assets });
  const mesh = testAssets(world)
    .create(await createProbeGlobalMesh(2, 2, 2))
    .unwrap();
  const materialAsset = Materials.standard({
    baseColor: [0.8, 0.4, 0.2, 1],
    roughness: 0.65,
    specular: 0,
  });
  const publication: { guid: string; asset: Asset; refs?: readonly string[] }[] = [];
  const publishMaterial = async (source: MaterialAsset) => {
    const guid = AssetGuid.format(AssetGuid.random());
    const cooked = await createMaterialPackCooker().cook({ guid, source });
    const record = validateCookedMaterialRecord(
      (cooked.payload as { cooked: unknown }).cooked,
    ).unwrap();
    const ready = await createMaterialLoader({
      loadPublication: async () => ({ guid, record, artifacts: cooked.artifacts }),
      loadReference: async () => true,
    }).load({ guid, specializationKey: record.specializationKey ?? '' });
    assert(ready.status === 'Ready');
    publication.push({ guid, asset: cooked.payload as MaterialAsset, refs: cooked.refs });
    publishRuntimeAssets(host.assets, publication);
    return (await host.assets.load(guid, 'material')).unwrap();
  };
  let offscreenMaterial: AssetHandle<'material'> | undefined;
  const material = nativeCards
    ? await publishMaterial(materialAsset)
    : host.assets.create(materialAsset).unwrap();
  if (nativeCards) {
    // A 64x64 checkerboard minifies into the 16x16 offscreen Cards. Its
    // generated levels must affect material RGB, independently of validity.
    const textureSize = coldTexture ? 64 : 4;
    // An even byte makes the cold mip average exactly 127, rather than the
    // 127.5 UNORM tie whose permitted rounding differs across real backends.
    const patternChannel = coldTexture ? 254 : 255;
    const pixels = Uint8Array.from({ length: textureSize * textureSize * 4 }, (_, i) =>
      i % 4 === 3
        ? 255
        : (
              coldTexture
                ? ((Math.floor(i / 4) % textureSize) + Math.floor(i / 4 / textureSize)) % 2 === 0
                : Math.floor(i / 4) % 4 < 2
            )
          ? i % 4 === 0
            ? patternChannel
            : 0
          : i % 4 === 1
            ? patternChannel
            : 0,
    );
    const textureGuid = '019a0000-0000-7000-8000-000000000331';
    const samplerGuid = '019a0000-0000-7000-8000-000000000332';
    publication.push(
      {
        guid: textureGuid,
        asset: {
          kind: 'texture',
          shape: { viewDimension: '2d', extent: { width: textureSize, height: textureSize } },
          format: 'rgba8unorm',
          colorSpace: 'linear',
          mips: { kind: 'generate' },
          data: pixels,
        },
      },
      {
        guid: samplerGuid,
        asset: {
          kind: 'sampler',
          minFilter: 'nearest',
          magFilter: 'nearest',
          mipmapFilter: 'nearest',
        },
      },
    );
    publishRuntimeAssets(host.assets, publication);
    (await host.assets.load(textureGuid, 'texture')).unwrap();
    (await host.assets.load(samplerGuid, 'sampler')).unwrap();
    offscreenMaterial = await publishMaterial(
      Materials.standard({
        baseColor: [1, 1, 1, 1],
        baseColorTexture: { texture: textureGuid, sampler: samplerGuid },
        roughness: 0.25,
      }),
    );
  }
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, -3] } },
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
  let seeds = [
    { id: 7, generation: 1, position: [0, 0, -2] as const, cellSize: 2, traced: true },
    { id: 8, generation: 1, position: [0, 0, -3] as const, cellSize: 2, traced: true },
    { id: 9, generation: 1, position: [10, 0, -2] as const, cellSize: 2, traced: true },
    { id: 10, generation: 1, position: [0, 0, -2] as const, cellSize: 2, traced: false },
  ];
  const enabled = () => ({
    ...profile,
    probePlacement: {
      seeds,
      global: {
        ...probeGlobalProfile,
        ...(nativeCards
          ? { cards: { resolution: 16, maxCaptureBytes: 1024 * 1024, budget: 4096 } }
          : {}),
      },
    },
  });
  const submit = () =>
    renderer.draw({
      leases: [lease],
      camera: { lease },
      environment: { lease },
      geometryLane,
    });
  const draw = async () => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    const result = submit();
    if (!result.ok)
      throw new Error(
        JSON.stringify({
          result,
          inspection: renderer.inspect().probePlacement,
          errors,
          rendererErrors,
        }),
      );
    renderValue(await result.value.completed);
    return result.value;
  };
  const hdr = async () => {
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    const receipt = await drawReadyFrame(
      renderer,
      { leases: [lease], camera: { lease }, environment: { lease }, geometryLane },
      ['linear-hdr'],
    );
    const item = renderValue(
      await renderer.observe(receipt, { include: ['linear-hdr'] }),
    ).observations?.find((item) => item.domain === 'linear-hdr');
    assert(item?.bytes.length);
    return item.bytes;
  };
  const settle = async () => {
    for (let i = 0; i < 120; i++) {
      await draw();
      if (renderer.inspect().probePlacement?.state === 'ready') return;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(
      JSON.stringify({ inspection: renderer.inspect().probePlacement, errors, rendererErrors }),
    );
  };
  const read = async (source: GPUBuffer) => {
    const result = native.createBuffer({ size: source.size, usage: 9 });
    try {
      const encoder = native.createCommandEncoder();
      encoder.copyBufferToBuffer(source, 0, result, 0, source.size);
      native.queue.submit([encoder.finish()]);
      await result.mapAsync(1);
      return new Uint8Array(result.getMappedRange().slice(0));
    } finally {
      result.destroy();
    }
  };
  const readTexture = async (texture: GPUTexture) => {
    const pixelBytes = texture.format === 'depth32float' ? 4 : 8;
    const rowBytes = texture.width * pixelBytes,
      stride = Math.ceil(rowBytes / 256) * 256;
    const buffer = native.createBuffer({ size: stride * texture.height, usage: 9 });
    try {
      const encoder = native.createCommandEncoder();
      encoder.copyTextureToBuffer(
        { texture, ...(pixelBytes === 4 ? { aspect: 'depth-only' as const } : {}) },
        { buffer, bytesPerRow: stride },
        [texture.width, texture.height],
      );
      native.queue.submit([encoder.finish()]);
      await buffer.mapAsync(1);
      const padded = new Uint8Array(buffer.getMappedRange()),
        result = new Uint8Array(rowBytes * texture.height);
      for (let row = 0; row < texture.height; row++)
        result.set(padded.subarray(row * stride, row * stride + rowBytes), row * rowBytes);
      return result;
    } finally {
      buffer.destroy();
    }
  };
  const packets: { name: string; tape: V7Tape; outputs: Record<string, Uint8Array> }[] = [];
  const capture = async (name: string, composing: boolean) => {
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const before = submitCount,
      start = performance.now();
    await draw();
    const queueWallMs = performance.now() - start;
    expect(submitCount - before).toBe(1);
    (await recorder.frameBoundary()).unwrap();
    const bytes = (await pending).unwrap().bytes,
      tape = decodeTape(bytes).unwrap(),
      model = buildFrameModel(tape);
    save(`${name}.rhitape`, bytes);
    writeFileSync(
      `${directory}/${name}-state.json`,
      JSON.stringify(
        { inspection: renderer.inspect().probePlacement, errors, rendererErrors },
        null,
        2,
      ),
    );
    const find = (label: string) =>
      model.works.find((work) => {
        const pass = model.passes[work.passIndex],
          event = pass && tape.events[pass.beginEventIndex];
        return event?.kind === 'beginComputePass' && event.desc?.label === label;
      });
    const place = find('probe-placement.update'),
      emit = find('probe-global.emit-rays'),
      query = find('probe-global.query'),
      support = find('probe-global.origin-support'),
      compose = find('probe-global.compose');
    assert(place && emit && query && support);
    expect(Boolean(compose)).toBe(composing);
    expect(place.workIndex).toBeLessThan(emit.workIndex);
    expect(emit.workIndex).toBeLessThan(query.workIndex);
    expect(query.workIndex).toBeLessThan(support.workIndex);
    const geometry = model.works.find((work) =>
      work.pipeline.shaders.some((shader) => shader.entryPoint === 'fs_gbuffer'),
    );
    assert(geometry);
    expect(geometry.workIndex).toBeLessThan(place.workIndex);
    if (compose) expect(compose.workIndex).toBeLessThan(query.workIndex);
    const binding = (work: typeof place, index: number) => {
      const bound = work.bindings.find((value) => value.binding === index);
      assert(bound?.resourceId);
      return bound;
    };
    expect(binding(place, 7).resourceId).toBe(binding(emit, 1).resourceId);
    expect(binding(emit, 1).resourceId).toBe(binding(support, 1).resourceId);
    expect(binding(emit, 3).resourceId).toBe(binding(query, 2).resourceId);
    expect(binding(query, 3).resourceId).toBe(binding(support, 3).resourceId);
    const select = find('probe-card.selectCandidates'),
      sample = find('probe-card.sampleCards'),
      cardSupport = find('probe-card.support');
    const captures = model.works.filter((work) =>
      work.pipeline.shaders.some((shader) => shader.entryPoint === 'fs_card'),
    );
    const mipWorks = model.works.filter((work) => {
      const pass = model.passes[work.passIndex],
        event = pass && tape.events[pass.beginEventIndex];
      return (
        event?.kind === 'beginRenderPass' &&
        /^probe-card\.material\.\d+\.mip-\d+$/.test(event.desc.label ?? '')
      );
    });
    if (coldTexture) {
      expect(mipWorks).toHaveLength(name === 'cold' ? 6 : 0);
      if (name === 'cold') {
        assert(captures[0]);
        expect(mipWorks.at(-1)?.workIndex).toBeLessThan(captures[0].workIndex);
        writeFileSync(
          `${directory}/cold-mip-model.json`,
          JSON.stringify(
            {
              works: mipWorks.concat(captures),
              resources: model.resources,
              unseededResources: model.unseededResources,
            },
            null,
            2,
          ),
        );
      }
    }
    if (nativeCards) {
      assert(select && sample && cardSupport);
      expect(captures.length).toBe(composing ? 12 : 0);
      if (captures.length) expect(captures.at(-1)?.workIndex).toBeLessThan(select.workIndex);
      expect(query.workIndex).toBeLessThan(select.workIndex);
      expect(select.workIndex).toBeLessThan(sample.workIndex);
      expect(sample.workIndex).toBeLessThan(cardSupport.workIndex);
      expect(binding(query, 3).resourceId).toBe(binding(select, 0).resourceId);
      expect(binding(select, 5).resourceId).toBe(binding(sample, 5).resourceId);
      expect(binding(sample, 7).resourceId).toBe(binding(cardSupport, 3).resourceId);
      expect(binding(emit, 3).resourceId).toBe(binding(cardSupport, 0).resourceId);
    } else expect(select).toBeUndefined();
    const descriptors = new Map(
      model.resources.map((resource) => [resource.resourceId, resource.descriptor]),
    );
    const outputs: Record<string, Uint8Array> = {};
    for (const [key, work, index] of [
      ['candidate', place, 7],
      ['rays', emit, 3],
      ['emission', emit, 4],
      ['hits', query, 3],
      ['support', support, 6],
      ...(select && sample && cardSupport
        ? ([
            ['card-candidates', select, 5],
            ['card-samples', sample, 7],
            ['card-support', cardSupport, 4],
          ] as const)
        : []),
    ] as const) {
      const id = binding(work, index).resourceId;
      assert(id);
      const descriptor = descriptors.get(id) as { desc: { label: string } };
      const source = buffers.get(descriptor.desc.label);
      assert(source);
      outputs[key] = await read(source);
      save(`${name}-${key}.bin`, outputs[key]);
    }
    if (nativeCards) {
      writeFileSync(
        `${directory}/${name}-atlas-descriptors.json`,
        JSON.stringify(
          Object.fromEntries(
            [...cardTextures].map(([label, texture]) => [
              label,
              { width: texture.width, height: texture.height, format: texture.format },
            ]),
          ),
          null,
          2,
        ),
      );
      for (const [label, texture] of cardTextures) {
        outputs[label] = await readTexture(texture);
        save(`${name}-${label}.bin`, outputs[label]);
      }
      const report = new DataView(outputs['card-support']?.buffer ?? new ArrayBuffer(0));
      const queryHits = new DataView(outputs.hits?.buffer ?? new ArrayBuffer(0));
      const originalRays = new DataView(outputs.rays?.buffer ?? new ArrayBuffer(0));
      const samples = new DataView(outputs['card-samples']?.buffer ?? new ArrayBuffer(0));
      const associations = new DataView(outputs['card-candidates']?.buffer ?? new ArrayBuffer(0));
      const counts = new Array<number>(6).fill(0);
      for (let i = 0; i < seeds.length * 81; i++) {
        const state = report.getUint32(i * 32, true);
        counts[state] = (counts[state] ?? 0) + 1;
        const status = queryHits.getUint32(i * 64, true);
        const hitT = queryHits.getFloat32(i * 64 + 16, true),
          min = originalRays.getFloat32(i * 48 + 12, true);
        let mapped = 0;
        for (let k = 0; k < 4; k++)
          if (samples.getUint32((i * 4 + k) * 112, true) === 1) mapped |= 1 << k;
        const expected =
          originalRays.getUint32(i * 48 + 32, true) === 0
            ? 0
            : status === 2 || (status === 1 && hitT <= min)
              ? 1
              : status === 1
                ? mapped && associations.getUint32(i * 32 + 4, true) === 0
                  ? 2
                  : 3
                : status === 0
                  ? 4
                  : 5;
        expect(state).toBe(expected);
        expect(report.getUint32(i * 32 + 4, true)).toBe(status);
        expect(report.getUint32(i * 32 + 12, true)).toBe(mapped);
      }
      writeFileSync(
        `${directory}/${name}-card-counts.json`,
        JSON.stringify({ counts, captures: captures.length }, null, 2),
      );
    }
    const candidate = new DataView(outputs.candidate?.buffer ?? new ArrayBuffer(0));
    const rays = new DataView(outputs.rays?.buffer ?? new ArrayBuffer(0)),
      hits = new DataView(outputs.hits?.buffer ?? new ArrayBuffer(0)),
      diagnostics = new DataView(outputs.support?.buffer ?? new ArrayBuffer(0));
    for (let p = 0; p < seeds.length; p++) {
      const seed = seeds[p];
      assert(seed);
      const counts = new Array<number>(8).fill(0);
      for (let r = 0; r < 81; r++) {
        const ray = (p * 81 + r) * 48;
        if (seed.traced) {
          for (let axis = 0; axis < 3; axis++)
            expect(rays.getFloat32(ray + axis * 4, true)).toBe(
              Math.fround(
                (seed.position[axis] ?? 0) + candidate.getFloat32(p * 32 + axis * 4, true),
              ),
            );
          const status = hits.getUint32((p * 81 + r) * 64, true);
          assert(status < 6);
          counts[status] = (counts[status] ?? 0) + 1;
        } else counts[6] = (counts[6] ?? 0) + 1;
      }
      expect(
        Array.from({ length: 8 }, (_, i) => diagnostics.getUint32(p * 96 + 64 + i * 4, true)),
      ).toEqual(counts);
      expect(diagnostics.getUint32(p * 96 + 32, true)).toBe(seed.id);
      if (seed.id === 8) expect(counts[2]).toBe(81);
      if (seed.id === 9) {
        expect(counts[5]).toBe(81);
        expect(diagnostics.getUint32(p * 96 + 52, true)).toBe(0);
      }
      if (seed.id === 10) expect(counts[6]).toBe(81);
    }
    save(`${name}.rhitape`, bytes);
    writeFileSync(
      `${directory}/${name}.json`,
      JSON.stringify(
        {
          queueWallMs,
          lane: 'software-gpu-diagnostic',
          geometryLane,
          composing,
          inspection: renderer.inspect().probePlacement,
          works: [geometry, place, ...(compose ? [compose] : []), emit, query, support],
        },
        null,
        2,
      ),
    );
    packets.push({ name, tape, outputs });
    return outputs;
  };
  try {
    renderValue(renderer.setProfile(profile));
    for (let i = 0; i < 8; i++) await draw();
    const baseline = await hdr();
    save('direct-only.rgba16f', baseline);
    if (offscreenMaterial) {
      world
        .spawn(
          { component: Transform, data: { pos: [6, 0, -3] } },
          { component: MeshFilter, data: { assetHandle: mesh } },
          {
            component: MeshRenderer,
            data: { materials: [offscreenMaterial] },
          },
        )
        .unwrap();
    }
    // Global and placement kernels prepare independently. Finish the ordinary
    // placement publication first so cold-region capture cannot race its kernel.
    renderValue(renderer.setProfile({ ...profile, probePlacement: { seeds } }));
    await settle();
    renderValue(renderer.setProfile(enabled()));
    await draw();
    await expect
      .poll(() => renderer.inspect().probePlacement?.global, { timeout: 10000 })
      .toBeDefined();
    const first = await capture('cold', true);
    const second = await capture('retained', false);
    assert(first.candidate);
    expect(new Float32Array(first.candidate.buffer)[2]).toBeGreaterThan(0);
    expect(second.rays).toEqual(first.rays);
    for (let i = 0; i < 60; i++) await draw();
    expect(renderer.inspect().probePlacement?.global?.compositionBuilds).toBe(1);
    const diagnosticHdr = await hdr();
    save('with-global.rgba16f', diagnosticHdr);
    expect(diagnosticHdr).toEqual(baseline);
    const accepted = renderer.inspect().probePlacement?.submittedFrames;
    assert(accepted);
    afterExtract = () => {
      world.spawn({ component: Transform, data: {} }).unwrap();
    };
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    const submissionsBeforeStaleSource = submitCount;
    const staleSource = submit();
    expect(afterExtract).toBeUndefined();
    expect(staleSource.ok).toBe(false);
    if (!staleSource.ok) expect(staleSource.error.code).toBe('frame-submit-rejected');
    expect(submitCount).toBe(submissionsBeforeStaleSource);
    expect(renderer.inspect().probePlacement?.submittedFrames).toBe(accepted);
    await draw();
    expect(renderer.inspect().probePlacement?.submittedFrames).toBe(accepted + 1);
    for (const failure of ['finish', 'submit'] as const) {
      const previous = renderer.inspect().probePlacement?.submittedFrames;
      if (failure === 'finish') failFinish = true;
      else failSubmit = true;
      const result = submit();
      expect(result.ok).toBe(false);
      expect(renderer.inspect().probePlacement?.submittedFrames).toBe(previous);
      await draw();
      expect(renderer.inspect().probePlacement?.submittedFrames).toBe((previous ?? 0) + 1);
    }
    const previous = renderer.inspect().probePlacement?.submittedFrames;
    afterPhysicalSubmit = () => {
      world.spawn({ component: Transform, data: {} }).unwrap();
    };
    const rejectedPublication = submit();
    expect(rejectedPublication.ok).toBe(true);
    if (rejectedPublication.ok) renderValue(await rejectedPublication.value.completed);
    expect(renderer.inspect().probePlacement?.submittedFrames).toBe(previous);
    await draw();
    expect(renderer.inspect().probePlacement?.submittedFrames).toBe((previous ?? 0) + 1);
    seeds = seeds.map((seed) => ({ ...seed, generation: 2 }));
    renderValue(renderer.setProfile(enabled()));
    // An explicit profile install invalidates the retained scene. Prepare its
    // replacement before capturing the first reset candidate and composition.
    await draw();
    await expect
      .poll(() => renderer.inspect().probePlacement?.global, { timeout: 10000 })
      .toBeDefined();
    await capture('reset', true);
    expect(renderer.inspect().probePlacement?.global?.compositionBuilds).toBe(2);
    renderValue(renderer.setProfile(profile));
    await draw();
    expect(renderer.inspect().probePlacement).toBeUndefined();
    renderValue(renderer.setProfile(enabled()));
    await settle();
    loseDevice();
    await expect.poll(() => renderer.state()).toBe('device-lost');
    renderValue(await renderer.recover());
    await settle();
    expect(await hdr()).toEqual(baseline);
    expect(errors).toEqual([]);
  } finally {
    unsubscribe();
    lease.dispose();
    renderValue(await renderer.dispose());
    surface?.destroy();
    (await recorder.dispose()).unwrap();
    for (const device of sourceDevices) device.destroy();
  }
  // The live renderer, its allocations and device are gone before every replay.
  for (const { name, tape, outputs } of packets) {
    const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
    const device = (
      await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
    ).unwrap();
    const raw = webgpu._internal_getRawDevice(device);
    assert(raw);
    raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    const replay = (
      await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })
    ).unwrap();
    try {
      const model = buildFrameModel(tape);
      if (coldTexture && name === 'cold') {
        const mipWorks = model.works.filter((work) => {
          const pass = model.passes[work.passIndex],
            event = pass && tape.events[pass.beginEventIndex];
          return (
            event?.kind === 'beginRenderPass' &&
            /^probe-card\.material\.\d+\.mip-\d+$/.test(event.desc.label ?? '')
          );
        });
        const view = (id: string | null | undefined) => {
          assert(id);
          const descriptor = model.resources.find((resource) => resource.resourceId === id)
            ?.descriptor as { sourceHandleId: string; desc: { baseMipLevel?: number } };
          assert(descriptor?.sourceHandleId);
          return descriptor;
        };
        const first = mipWorks[0];
        assert(first);
        const texture = view(first.attachments?.colorViewHandleIds[0]).sourceHandleId;
        const source = (await replay.readResource(texture, { mipLevel: 0, arrayLayer: 0 })).unwrap()
          .bytes;
        expect(source).toHaveLength(64 * 64 * 4);
        for (let pixel = 0; pixel < 64 * 64; pixel++) {
          const red = ((pixel % 64) + Math.floor(pixel / 64)) % 2 === 0;
          expect(Array.from(source.subarray(pixel * 4, pixel * 4 + 4))).toEqual(
            red ? [254, 0, 0, 255] : [0, 254, 0, 255],
          );
        }
        save('cold-material-source-mip-0.bin', source);
        for (const [index, work] of mipWorks.entries()) {
          const target = view(work.attachments?.colorViewHandleIds[0]),
            source = view(work.bindings.find((binding) => binding.binding === 1)?.resourceId);
          expect(target.sourceHandleId).toBe(texture);
          expect(source.sourceHandleId).toBe(texture);
          expect(source.desc.baseMipLevel).toBe(index);
          expect(target.desc.baseMipLevel).toBe(index + 1);
          const before = (
            await replay.readResource(texture, { mipLevel: index + 1, arrayLayer: 0 })
          ).unwrap().bytes;
          expect(before).toEqual(new Uint8Array(before.length));
          save(`cold-material-unwritten-mip-${index + 1}.bin`, before);
        }
        const materialReads = model.works.filter(
          (work) =>
            work.pipeline.shaders.some((shader) => shader.entryPoint === 'fs_card') &&
            work.bindings.some(
              (binding) =>
                binding.resourceKind === 'textureView' &&
                view(binding.resourceId).sourceHandleId === texture,
            ),
        );
        expect(materialReads).toHaveLength(6);
        for (const work of materialReads)
          expect(work.workIndex).toBeGreaterThan(mipWorks.at(-1)?.workIndex ?? -1);
        for (const [index, work] of mipWorks.entries()) {
          const after = (
            await replay.readResourceAtWork(texture, work.workIndex, {
              mipLevel: index + 1,
              arrayLayer: 0,
            })
          ).unwrap().bytes;
          for (let pixel = 0; pixel < after.length / 4; pixel++)
            expect(Array.from(after.subarray(pixel * 4, pixel * 4 + 4))).toEqual([
              127, 127, 0, 255,
            ]);
          save(`cold-material-generated-mip-${index + 1}.bin`, after);
        }
      }
      for (const [key, label, index] of [
        ['candidate', 'probe-placement.update', 7],
        ['rays', 'probe-global.emit-rays', 3],
        ['emission', 'probe-global.emit-rays', 4],
        ['hits', 'probe-global.query', 3],
        ['support', 'probe-global.origin-support', 6],
        ...(nativeCards
          ? ([
              ['card-candidates', 'probe-card.selectCandidates', 5],
              ['card-samples', 'probe-card.sampleCards', 7],
              ['card-support', 'probe-card.support', 4],
            ] as const)
          : []),
      ] as const) {
        const work = model.works.find((work) => {
          const pass = model.passes[work.passIndex],
            event = pass && tape.events[pass.beginEventIndex];
          return event?.kind === 'beginComputePass' && event.desc?.label === label;
        });
        assert(work);
        const bound = work.bindings.find((value) => value.binding === index);
        assert(bound?.resourceId);
        const inspection = (
          await replay.inspectWork(work.workIndex, ['pipeline', 'bindings'])
        ).unwrap();
        expect(inspection.workIndex).toBe(work.workIndex);
        const bytes = (await replay.readResourceAtWork(bound.resourceId, work.workIndex)).unwrap()
          .bytes;
        expect(bytes).toEqual(outputs[key]);
        save(`${name}-replay-${key}.bin`, bytes);
      }
      if (nativeCards) {
        const sample = model.works.find((work) =>
          work.pipeline.shaders.some((shader) => shader.entryPoint === 'sampleCards'),
        );
        assert(sample);
        const capture = model.works
          .filter((work) => work.pipeline.shaders.some((shader) => shader.entryPoint === 'fs_card'))
          .at(-1);
        for (const [index, key] of [
          'albedoRoughness',
          'normals',
          'emissionMetallic',
          'f0Validity',
          'depth',
        ].entries()) {
          const resource = sample.bindings.find((value) => value.binding === index + 9)?.resourceId;
          assert(resource);
          const bytes = (
            await replay.readResourceAtWork(resource, capture?.workIndex ?? sample.workIndex)
          ).unwrap().bytes;
          expect(bytes).toEqual(outputs[`cards.${key}`]);
          save(`${name}-replay-cards.${key}.bin`, bytes);
        }
      }
    } finally {
      (await replay.dispose()).unwrap();
      raw.destroy();
    }
  }
  if (nativeCards) {
    const cold = packets.find((packet) => packet.name === 'cold');
    assert(cold);
    const model = buildFrameModel(cold.tape);
    const support = model.works.find((work) => {
      const pass = model.passes[work.passIndex],
        event = pass && cold.tape.events[pass.beginEventIndex];
      return event?.kind === 'beginComputePass' && event.desc?.label === 'probe-card.support';
    });
    assert(support);
    for (const skipped of [
      'fs_card',
      'selectCandidates',
      'sampleCards',
      'support',
      ...(coldTexture ? ['mips'] : []),
    ]) {
      const indices = new Set(
        model.works
          .filter((work) => {
            if (skipped === 'support') return work === support;
            if (skipped === 'mips') {
              const pass = model.passes[work.passIndex],
                event = pass && cold.tape.events[pass.beginEventIndex];
              return (
                event?.kind === 'beginRenderPass' &&
                /^probe-card\.material\.\d+\.mip-\d+$/.test(event.desc.label ?? '')
              );
            }
            return work.pipeline.shaders.some((shader) => shader.entryPoint === skipped);
          })
          .map((work) => work.eventIndex),
      );
      assert(indices.size > 0);
      const modified = encodeTape({
        ...cold.tape,
        events: cold.tape.events.map((event, index) =>
          !indices.has(index)
            ? event
            : event.kind === 'draw'
              ? { ...event, vertexCount: 0 }
              : event.kind === 'dispatchWorkgroups'
                ? { ...event, x: 0 }
                : event,
        ),
      }).unwrap();
      save(`missing-${skipped}.rhitape`, modified);
      const checked = decodeTape(modified).unwrap();
      const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
      const device = (
        await adapter.requestDevice(replayDeviceRequest(checked, adapter.features, adapter.limits))
      ).unwrap();
      const raw = webgpu._internal_getRawDevice(device);
      assert(raw);
      raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
      const replay = (
        await openReplay(checked, { device, createShaderModule: webgpu.createShaderModule })
      ).unwrap();
      try {
        const output = support.bindings.find((binding) => binding.binding === 4)?.resourceId;
        assert(output);
        const bytes = (await replay.readResourceAtWork(output, support.workIndex)).unwrap().bytes;
        if (skipped === 'mips') {
          const sample = model.works.find((work) =>
            work.pipeline.shaders.some((shader) => shader.entryPoint === 'sampleCards'),
          );
          assert(sample);
          const albedo = sample.bindings.find((binding) => binding.binding === 9)?.resourceId;
          assert(albedo);
          const texels = (await replay.readResourceAtWork(albedo, sample.workIndex)).unwrap().bytes;
          save('missing-mips-cards.albedoRoughness.bin', texels);
          const original = cold.outputs['cards.albedoRoughness'];
          assert(original);
          let changedRgbTexels = 0;
          for (let offset = 0; offset < texels.length; offset += 8) {
            if (
              !texels
                .subarray(offset, offset + 6)
                .every((value, channel) => value === original[offset + channel])
            )
              changedRgbTexels++;
            expect(texels.subarray(offset + 6, offset + 8)).toEqual(
              original.subarray(offset + 6, offset + 8),
            );
          }
          expect(changedRgbTexels).toBe(6 * 16 * 16);
          const validity = sample.bindings.find((binding) => binding.binding === 12)?.resourceId;
          assert(validity);
          const validityTexels = (
            await replay.readResourceAtWork(validity, sample.workIndex)
          ).unwrap().bytes;
          expect(validityTexels).toEqual(cold.outputs['cards.f0Validity']);
          save('missing-mips-cards.f0Validity.bin', validityTexels);
          writeFileSync(
            `${directory}/missing-mips-result.json`,
            JSON.stringify(
              {
                omittedMipDraws: indices.size,
                changedRgbTexels,
                roughnessUnchanged: true,
                f0ValidityUnchanged: true,
              },
              null,
              2,
            ),
          );
          // A valid black material is still valid. Missing mips must affect the
          // captured material, not manufacture an unsupported-surface result.
          expect(bytes).toEqual(cold.outputs['card-support']);
        } else {
          expect(bytes).not.toEqual(cold.outputs['card-support']);
          const view = new DataView(bytes.buffer);
          expect(
            Array.from({ length: bytes.length / 32 }, (_, index) =>
              view.getUint32(index * 32, true),
            ).filter((state) => state === 2),
          ).toHaveLength(0);
        }
        for (const [index, key] of [
          [0, 'rays'],
          [1, 'hits'],
        ] as const) {
          const input = support.bindings.find((binding) => binding.binding === index)?.resourceId;
          assert(input);
          expect(
            (await replay.readResourceAtWork(input, support.workIndex)).unwrap().bytes,
          ).toEqual(cold.outputs[key]);
        }
        save(`missing-${skipped}-support.bin`, bytes);
      } finally {
        (await replay.dispose()).unwrap();
        raw.destroy();
      }
    }
  }
  expect(errors).toEqual([]);
}, 180000);
