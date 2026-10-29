import { mkdirSync, writeFileSync } from 'node:fs';
import { Materials, MeshRenderer } from '@forgeax/engine-render';
import {
  CardLookupStatus,
  GlobalSdfQueryStatus,
  IRRADIANCE_FIELD_COVERAGE_BYTES,
  IRRADIANCE_FIELD_COVERAGE_WGSL,
} from '@forgeax/engine-render/internal';
import { attachRecorder, buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { ok } from '@forgeax/engine-types';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { assert, expect, it } from 'vitest';
import { publishRuntimeAssets } from '../../../assets-runtime/src/__tests__/fixtures/runtime-publication';
import {
  createIrradianceFieldHarness,
  irradianceFieldGi,
} from './renderer-irradiance-field.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

const manifest = shaderManifestUrl(await buildEngineShaderManifest());
const directory = 'artifacts/irradiance-field/dawn';
mkdirSync(directory, { recursive: true });

const CARD_RESOLUTION = 16;
const ALPHA_BLEND = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
} as const;
/** Kernel bindings 0-6 and 9-15 are the Renderer's live world-trace resources. */
const BINDINGS: readonly (readonly [number, string])[] = [
  [0, 'probe-global.voxels'],
  [1, 'probe-global.settings'],
  [2, 'probe-global.instances'],
  [3, 'probe-global.fields'],
  [4, 'probe-global.bounds'],
  [5, 'probe-global.card-projections'],
  [6, 'irradiance-field.card-lit'],
  [9, 'irradiance-field.frame'],
  [10, 'probe-global.card-settings'],
  [11, 'cards.albedoRoughness'],
  [12, 'cards.normals'],
  [13, 'cards.emissionMetallic'],
  [14, 'cards.f0Validity'],
  [15, 'cards.depth'],
];

interface Coverage {
  readonly status: number;
  readonly lookup: number;
  readonly t: number;
  readonly albedo: readonly [number, number, number];
}

/** Live GPU resources of the retained field, keyed by label (latest allocation wins). */
function trackFieldResources(device: GPUDevice) {
  const buffers = new Map<string, GPUBuffer>();
  const textures = new Map<string, GPUTexture>();
  const owned = (label: string | undefined): label is string =>
    label !== undefined && /^(probe-global|cards|irradiance-field)\./.test(label);
  const createBuffer = device.createBuffer.bind(device);
  device.createBuffer = (descriptor) => {
    const buffer = createBuffer(descriptor);
    if (owned(descriptor.label)) buffers.set(descriptor.label, buffer);
    return buffer;
  };
  const createTexture = device.createTexture.bind(device);
  device.createTexture = (descriptor) => {
    const texture = createTexture(descriptor);
    if (owned(descriptor.label)) textures.set(descriptor.label, texture);
    return texture;
  };
  const buffer = (label: string) => {
    const resource = buffers.get(label);
    assert(resource, `the field allocated buffer ${label}`);
    return resource;
  };
  const texture = (label: string) => {
    const resource = textures.get(label);
    assert(resource, `the field allocated texture ${label}`);
    return resource;
  };
  const readBuffer = async (source: GPUBuffer) => {
    const target = device.createBuffer({ size: source.size, usage: 9 });
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(source, 0, target, 0, source.size);
    device.queue.submit([encoder.finish()]);
    await target.mapAsync(1);
    const bytes = new Uint8Array(target.getMappedRange().slice(0));
    target.destroy();
    return bytes;
  };
  return {
    readBuffer: (label: string) => readBuffer(buffer(label)),
    /** rgba16float atlas plane as rows of `width * 8` bytes. */
    async readAtlas(label: string) {
      const plane = texture(label);
      const row = Math.ceil((plane.width * 8) / 256) * 256;
      const target = device.createBuffer({ size: row * plane.height, usage: 9 });
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: plane }, { buffer: target, bytesPerRow: row }, [
        plane.width,
        plane.height,
      ]);
      device.queue.submit([encoder.finish()]);
      await target.mapAsync(1);
      const padded = new Uint8Array(target.getMappedRange());
      const bytes = new Uint8Array(plane.width * 8 * plane.height);
      for (let y = 0; y < plane.height; y++)
        bytes.set(padded.subarray(y * row, y * row + plane.width * 8), y * plane.width * 8);
      target.destroy();
      return { width: plane.width, height: plane.height, bytes };
    },
    /** The diagnostic world trace over caller rays against the live field. */
    async classify(rays: readonly { origin: number[]; direction: number[] }[]) {
      const data = new ArrayBuffer(rays.length * 48);
      const f = new Float32Array(data);
      const u = new Uint32Array(data);
      rays.forEach((ray, i) => {
        const length = Math.hypot(...ray.direction);
        f.set([...ray.origin, 0], i * 12);
        f.set([...ray.direction.map((d) => d / length), 8], i * 12 + 4);
        u.set([1, 0, 0, 0], i * 12 + 8);
      });
      device.pushErrorScope('validation');
      const module = device.createShaderModule({ code: IRRADIANCE_FIELD_COVERAGE_WGSL });
      const pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module, entryPoint: 'classifyRays' },
      });
      const rayBuffer = device.createBuffer({ size: data.byteLength, usage: 0x80 | 8 });
      device.queue.writeBuffer(rayBuffer, 0, data);
      const out = device.createBuffer({
        size: rays.length * IRRADIANCE_FIELD_COVERAGE_BYTES,
        usage: 0x80 | 4,
      });
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 7, resource: { buffer: rayBuffer } },
          { binding: 8, resource: { buffer: out } },
          ...BINDINGS.map(([binding, label]) => ({
            binding,
            resource: label.startsWith('cards.')
              ? texture(label).createView()
              : { buffer: buffer(label) },
          })),
        ],
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(rays.length / 64));
      pass.end();
      device.queue.submit([encoder.finish()]);
      const error = await device.popErrorScope();
      expect(error?.message).toBeUndefined();
      const bytes = await readBuffer(out);
      rayBuffer.destroy();
      out.destroy();
      const records = new Uint32Array(bytes.buffer);
      const floats = new Float32Array(bytes.buffer);
      return rays.map((_, i): Coverage => {
        const base = (i * IRRADIANCE_FIELD_COVERAGE_BYTES) / 4;
        return {
          status: records[base] ?? -1,
          lookup: records[base + 3] ?? -1,
          t: floats[base + 8] ?? Number.NaN,
          albedo: [floats[base + 16] ?? 0, floats[base + 17] ?? 0, floats[base + 18] ?? 0],
        };
      });
    },
  };
}

/** 16x16 atlas tiles whose albedo/roughness texels differ. */
function changedTiles(
  before: { width: number; height: number; bytes: Uint8Array },
  after: { bytes: Uint8Array },
) {
  const changed = new Set<number>();
  const columns = before.width / CARD_RESOLUTION;
  for (let i = 0; i < before.bytes.length; i++)
    if (before.bytes[i] !== after.bytes[i]) {
      const texel = Math.floor(i / 8);
      const x = Math.floor((texel % before.width) / CARD_RESOLUTION);
      const y = Math.floor(Math.floor(texel / before.width) / CARD_RESOLUTION);
      changed.add(y * columns + x);
    }
  return changed.size;
}

it('maps Global SDF hits to Card materials, recaptures in place on a material edit, and rejects unsupported materials structurally', {
  timeout: 900_000,
}, async () => {
  const recorder = attachRecorder(webgpu).unwrap();
  const h = await createIrradianceFieldHarness({
    rhi: recorder.backend.rhi,
    manifest,
    instrumentation: {
      onDeviceLost: () => recorder.deviceLost(),
      resolveSurfaceDevice: (
        device: Parameters<typeof recorder.backend.unwrapDeviceForSurface>[0],
      ) => ok(recorder.backend.unwrapDeviceForSurface(device).unwrap()),
    },
  });
  const result: Record<string, unknown> = {};
  let stage = 'initial capture';
  const inspectField = () => {
    const gi = h.inspection();
    assert('gather' in gi && gi.gather === 'irradiance-field');
    return gi;
  };
  try {
    await h.draw();
    const device = h.native();
    assert(device, 'the canvas configured its device');
    const field = trackFieldResources(device);
    const surface = (baseColor: [number, number, number, number], extra = {}) =>
      Materials.standard({ baseColor, roughness: 1, specular: 0, ...extra });
    const red = await h.publish(surface([1, 0, 0, 1]));
    // A 1 m box in front of the wall: its front face is at z = -1, the wall's at -2.875.
    const box = h.spawn(await h.slab(1, 1, 1), h.white, [0, 0, -1.5]);
    h.setGi(irradianceFieldGi({ environment: [0.25, 0.25, 0.25] }));
    await h.settle(2);
    const prepared = inspectField();
    assert(prepared.gather === 'irradiance-field' && prepared.cards);
    expect(prepared.cards.captured).toBe(prepared.cards.tiles);

    // Coverage: both surfaces are SDF hits that map to their Card material, at the
    // triangle distance within one Global SDF cell (0.5 m).
    const rays = [
      { origin: [0, 0, 0], direction: [0, 0, -1] },
      { origin: [0, 0, 0], direction: [0.7, 0.7, -1] },
    ];
    const truth = [1, 2.875 * Math.hypot(0.7, 0.7, 1)];
    const white = await field.classify(rays);
    for (const [i, record] of white.entries()) {
      expect(record.status).toBe(GlobalSdfQueryStatus.hit);
      expect(record.lookup).toBe(CardLookupStatus.mapped);
      expect(Math.abs(record.t - (truth[i] ?? 0))).toBeLessThan(0.5);
      for (const channel of record.albedo) expect(channel).toBeGreaterThan(0.9);
    }

    // Material edit: the field rematerializes the box in place (no new generation),
    // its Cards recapture, the Global SDF keeps its voxels, and only the edited
    // box's Card tiles change. Card admission is asynchronous, so every frame is
    // recorded until the one that applies the edit and recaptures its tiles.
    const voxels = await field.readBuffer('probe-global.voxels');
    const atlas = await field.readAtlas('cards.albedoRoughness');
    const generation = prepared.generation;
    h.world.set(box, MeshRenderer, { materials: [red] }).unwrap();
    let tape: Awaited<ReturnType<typeof recorder.captureFrame>> | undefined;
    let lastEditFrame: Awaited<ReturnType<typeof recorder.captureFrame>> | undefined;
    for (let frame = 0; frame < 400; frame++) {
      const gi = inspectField();
      expect(gi.state).not.toBe('failed');
      if (tape === undefined) {
        const pending = recorder.captureFrame();
        (await recorder.frameBoundary()).unwrap();
        await h.draw();
        (await recorder.frameBoundary()).unwrap();
        const recorded = await pending;
        lastEditFrame = recorded;
        if ((inspectField().edits?.rematerializedInstances ?? 0) > 0) tape = recorded;
        continue;
      }
      if (gi.edits?.pendingTiles === 0) break;
      await h.draw();
    }
    if (tape === undefined && lastEditFrame?.ok)
      writeFileSync(`${directory}/coverage-edit-pending.rhitape`, lastEditFrame.value.bytes);
    assert(tape, 'a frame after the edit recaptured Cards');
    const encoded = tape.unwrap();
    writeFileSync(`${directory}/coverage-edit.rhitape`, encoded.bytes);
    const model = buildFrameModel(decodeTape(encoded.bytes).unwrap());
    // Capture pipelines keep their labels in the tape: draw -> instance, indices, material.
    const captures = model.works.flatMap((work) => {
      const descriptor = work.pipeline.descriptor;
      const desc =
        descriptor && typeof descriptor === 'object' && 'desc' in descriptor
          ? descriptor.desc
          : undefined;
      const label = desc && typeof desc === 'object' && 'label' in desc ? desc.label : undefined;
      const match =
        typeof label !== 'string'
          ? null
          : /^cards\.capture\.instance-(\d+)\.indices-(\d+)-(\d+)\.material-(\d+)$/.exec(label);
      return match ? [{ workIndex: work.workIndex, instanceId: Number(match[1]) }] : [];
    });
    const edited = inspectField();
    assert(edited.gather === 'irradiance-field' && edited.cards);
    expect(edited.generation).toBe(generation);
    expect(edited.edits).toMatchObject({ rematerializedInstances: 1, pendingTiles: 0 });
    expect(edited.cards.captured).toBe(edited.cards.tiles);
    expect(captures.length).toBeGreaterThanOrEqual(6);
    expect(new Set(captures.map((c) => c.instanceId)).size).toBeGreaterThanOrEqual(1);
    expect(await field.readBuffer('probe-global.voxels')).toEqual(voxels);
    const changed = changedTiles(atlas, await field.readAtlas('cards.albedoRoughness'));
    expect(changed).toBeGreaterThan(0);
    expect(changed).toBeLessThanOrEqual(6);
    const [boxHit, wallHit] = await field.classify(rays);
    assert(boxHit && wallHit);
    expect(boxHit.lookup).toBe(CardLookupStatus.mapped);
    expect(boxHit.albedo[0]).toBeGreaterThan(0.9);
    expect(boxHit.albedo[1]).toBeLessThan(0.05);
    expect(wallHit.albedo[1]).toBeGreaterThan(0.9);
    result.edit = {
      generation: [generation, edited.generation],
      tiles: edited.cards.tiles,
      recapturedDraws: captures.length,
      changedTiles: changed,
      tape: { digest: encoded.digest, works: model.works.length },
    };

    // Editing the asset itself uses the accepted material frame without touching
    // MeshRenderer. It recaptures the same six tiles and keeps the SDF intact.
    stage = 'material value update';
    const redAtlas = await field.readAtlas('cards.albedoRoughness');
    const beforeAssetEdit = inspectField().edits;
    assert(beforeAssetEdit);
    h.assets.update(red, { values: { baseColor: [0, 1, 0, 1] } }).unwrap();
    await h.settle(1);
    const assetEdited = inspectField();
    expect(assetEdited.generation).toBe(generation);
    expect(assetEdited.edits).toMatchObject({
      rematerializedInstances: beforeAssetEdit.rematerializedInstances,
      // Only the one row reading the edited material is re-admitted.
      projectedSources: beforeAssetEdit.projectedSources + 1,
      materialRootUpdates: beforeAssetEdit.materialRootUpdates + 1,
      materialDrawVisits: beforeAssetEdit.materialDrawVisits + 6,
      materialUniformUploads: beforeAssetEdit.materialUniformUploads + 1,
      pendingTiles: 0,
    });
    expect(await field.readBuffer('probe-global.voxels')).toEqual(voxels);
    const assetChangedTiles = changedTiles(
      redAtlas,
      await field.readAtlas('cards.albedoRoughness'),
    );
    expect(assetChangedTiles).toBeGreaterThan(0);
    expect(assetChangedTiles).toBeLessThanOrEqual(6);
    const [greenHit, unchangedWall] = await field.classify(rays);
    assert(greenHit && unchangedWall);
    expect(greenHit.lookup).toBe(CardLookupStatus.mapped);
    expect(greenHit.albedo[0]).toBeLessThan(0.05);
    expect(greenHit.albedo[1]).toBeGreaterThan(0.9);
    expect(unchangedWall.albedo[0]).toBeGreaterThan(0.9);
    result.assetEdit = {
      generation: assetEdited.generation,
      changedTiles: assetChangedTiles,
      edits: assetEdited.edits,
    };

    // Resource edits keep their handles. Only the dependency's physical Card work
    // refreshes native bindings; unrelated Cards and the Global SDF stay intact.
    const textureGuid = '019a0000-0000-7000-8000-000000000731';
    const samplerGuid = '019a0000-0000-7000-8000-000000000732';
    const pattern = Uint8Array.from({ length: 4 * 4 * 4 }, (_, i) =>
      i % 4 === 3 ? 255 : i % 4 === (Math.floor(i / 4) % 4 < 2 ? 0 : 2) ? 255 : 0,
    );
    const dependencies: Parameters<typeof publishRuntimeAssets>[1] = [
      {
        guid: textureGuid,
        asset: {
          kind: 'texture',
          shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
          format: 'rgba8unorm',
          colorSpace: 'linear',
          mips: { kind: 'generate' },
          data: pattern,
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
    ];
    stage = 'resource publication';
    publishRuntimeAssets(h.assets, dependencies);
    const textureHandle = (await h.assets.load(textureGuid, 'texture')).unwrap();
    const samplerHandle = (await h.assets.load(samplerGuid, 'sampler')).unwrap();
    stage = 'textured material publication';
    const textured = await h.publish(
      surface([1, 1, 1, 1], {
        baseColorTexture: { texture: textureGuid, sampler: samplerGuid },
      }),
      dependencies,
    );
    stage = 'textured material capture';
    h.world.set(box, MeshRenderer, { materials: [textured] }).unwrap();
    await h.settle(1);
    const resources: unknown[] = [];
    for (const kind of ['sampler', 'texture'] as const) {
      stage = `${kind} value update`;
      const before = inspectField();
      const edits = before.edits;
      assert(edits);
      const atlas = await field.readAtlas('cards.albedoRoughness');
      if (kind === 'sampler')
        h.assets.update(samplerHandle, { minFilter: 'linear', magFilter: 'linear' }).unwrap();
      else
        h.assets
          .update(textureHandle, {
            data: Uint8Array.from({ length: 4 * 4 * 4 }, (_, i) =>
              i % 4 === 1 || i % 4 === 3 ? 255 : 0,
            ),
          })
          .unwrap();
      if (kind === 'texture') {
        h.rejectNextSubmit();
        expect(h.submit().ok).toBe(false);
        const rejected = inspectField();
        expect(rejected.submittedFrames).toBe(before.submittedFrames);
        expect(rejected.edits?.pendingTiles).toBe(6);
        expect(await field.readAtlas('cards.albedoRoughness')).toEqual(atlas);
        h.errors.length = 0;
      }
      await h.settle(1);
      const after = inspectField();
      expect(after.generation).toBe(before.generation);
      expect(after.edits).toMatchObject({
        projectedSources: edits.projectedSources,
        rematerializedInstances: edits.rematerializedInstances,
        assetRootUpdates: edits.assetRootUpdates + 1,
        materialBindingRefreshes: edits.materialBindingRefreshes + 1,
        materialDrawVisits: edits.materialDrawVisits + (kind === 'texture' ? 12 : 6),
        materialUniformUploads: edits.materialUniformUploads,
        pendingTiles: 0,
      });
      expect(await field.readBuffer('probe-global.voxels')).toEqual(voxels);
      const changed = changedTiles(atlas, await field.readAtlas('cards.albedoRoughness'));
      expect(changed).toBeGreaterThan(0);
      expect(changed).toBeLessThanOrEqual(6);
      const [hit, wall] = await field.classify(rays);
      assert(hit && wall);
      if (kind === 'texture') {
        expect(hit.albedo[0]).toBeLessThan(0.05);
        expect(hit.albedo[1]).toBeGreaterThan(0.9);
      }
      expect(wall.albedo[0]).toBeGreaterThan(0.9);
      resources.push({ kind, changedTiles: changed, edits: after.edits });
    }
    result.resourceEdits = resources;

    stage = 'masked material publication';
    // MASK is admitted through its conservative proxy; the field stays ready.
    const mask = await h.publish(surface([1, 1, 1, 0.3], { alphaCutoff: 0.5 }));
    h.world.set(box, MeshRenderer, { materials: [mask] }).unwrap();
    await h.settle(1);
    expect(inspectField().state).toBe('ready');

    // Unsupported materials fail the whole field with a structured cause, never a hole.
    const rejection = async (source: ReturnType<typeof surface>) => {
      h.world.set(box, MeshRenderer, { materials: [await h.publish(source)] }).unwrap();
      for (let frame = 0; frame < 120; frame++) {
        await h.draw();
        const gi = inspectField();
        if (gi.state === 'failed') return gi.error;
      }
      return undefined;
    };
    const blend = await rejection(
      surface([1, 1, 1, 0.5], { renderState: { blend: ALPHA_BLEND, depthWriteEnabled: false } }),
    );
    // The Renderer error carries the field's preparation failure as its detail.
    expect(blend).toMatchObject({
      detail: {
        error: {
          code: 'irradiance-field-preparation',
          detail: { code: 'ray-reference-invalid', detail: { cause: 'baseColor opacity' } },
        },
      },
    });
    const failedGeneration = inspectField().generation;
    const failedErrors = h.errors.length;
    for (let frame = 0; frame < 3; frame++) await h.draw();
    expect(inspectField().generation).toBe(failedGeneration);
    expect(inspectField().error).toEqual(blend);
    expect(h.errors).toHaveLength(failedErrors);
    h.errors.length = 0;
    const twoSided = await rejection(surface([1, 1, 1, 1], { renderState: { cullMode: 'none' } }));
    expect(twoSided).toMatchObject({
      detail: {
        error: {
          code: 'irradiance-field-preparation',
          detail: {
            code: 'ray-reference-invalid',
            detail: { cause: expect.stringMatching(/sidedness/) },
          },
        },
      },
    });
    h.errors.length = 0;
    result.rejections = { blend, twoSided };

    // A corrected source recovers without toggling GI or replacing the Renderer.
    h.world.set(box, MeshRenderer, { materials: [h.white] }).unwrap();
    await h.settle(2);
    const recovered = inspectField();
    assert(recovered.gather === 'irradiance-field' && recovered.cards);
    expect(recovered.state).toBe('ready');
    expect(recovered.generation).toBeGreaterThan(failedGeneration);
    expect(recovered.cards.captured).toBe(recovered.cards.tiles);
    expect(recovered.error).toBeUndefined();
    for (const record of await field.classify(rays)) {
      expect(record.status).toBe(GlobalSdfQueryStatus.hit);
      expect(record.lookup).toBe(CardLookupStatus.mapped);
      for (const channel of record.albedo) expect(channel).toBeGreaterThan(0.9);
    }
    expect(h.errors).toEqual([]);
    result.recovered = { generation: recovered.generation, cards: recovered.cards };
    writeFileSync(`${directory}/coverage.json`, JSON.stringify(result, null, 2));
  } catch (cause) {
    writeFileSync(
      `${directory}/coverage-failed.json`,
      JSON.stringify({ stage, ...result }, null, 2),
    );
    if (cause instanceof Error) throw cause;
    throw new Error(`${stage}: ${JSON.stringify(cause)}`);
  } finally {
    await h.dispose();
    (await recorder.dispose()).unwrap();
  }
});
