import type { Buffer, RhiDevice, Texture, TextureView } from '@forgeax/engine-rhi';
import { assert, expect, vi } from 'vitest';
import { encodePng } from '../../../../image/src/png-encoder';
import { compileShader } from '../../../../shader-compiler/src/index';
import { packCardLookupProjections } from '../../raytracing/card-lookup';
import {
  createIrradianceFieldKernel,
  type IrradianceFieldKernelInput,
  irradianceFieldKernelWgsl,
  packIrradianceFieldFrame,
} from '../../raytracing/irradiance-field';
import { rayGeometryKey } from '../../raytracing/scene';
import { prepareSurfaceCapture } from '../../raytracing/surface-cards';
import { prepareCardContactCapture } from './card-contact-capture.fixture';
import { triangleOnSegment, type V3 } from './card-contact-physical.fixture';
import { readBuffer } from './path-tracer.fixture';
import { half } from './sdf-cards.fixture';

type Compile = Parameters<typeof prepareSurfaceCapture>[1];
type Save = (name: string, bytes: Uint8Array) => Promise<void>;
type Resource = TextureView | { readonly buffer: Buffer; readonly size?: number };

/** Observe an unmodified full production World call and return its original Hit.
 * The extra diagnostic storage is the eighth SSBO, not a production binding. */
export function observedCardContact(source: string) {
  const marker = 'let hit=traceWorld(';
  if (source.split(marker).length !== 2) throw Error('One actual Card World query required');
  return (
    source.replace(marker, 'let hit=observedCardContact(texel,l,') +
    `
struct CardContactWitness { control:vec4u, state:vec4u, originLo:vec4u, originHi:vec4u, directionLo:vec4u, directionHi:vec4u }
@group(0) @binding(17) var<storage,read_write> contactWitnesses:array<CardContactWitness>;
fn observedCardContact(texel:u32,light:u32,ray:Ray,budget:u32,epsilon:f32,originHi:vec3u,directionHi:vec3u,contact:SdfSurfaceContact)->Hit {
 let hit=traceWorld(ray,budget,epsilon,originHi,directionHi,contact);
 let at=texel*frame.cards.w+light;
 if(at<arrayLength(&contactWitnesses)){
  contactWitnesses[at]=CardContactWitness(vec4u(1u,budget,contact.row,contact.primitive),hit.state,
   vec4u(bitcast<vec3u>(ray.origin),bitcast<u32>(ray.tMin)),vec4u(originHi,bitcast<u32>(ray.tMax)),
   vec4u(bitcast<vec3u>(ray.direction),0u),vec4u(directionHi,0u));
 }
 return hit;
}`
  );
}

async function observedKernel(device: RhiDevice, compile: Compile, save: Save) {
  const source = observedCardContact(irradianceFieldKernelWgsl('global-sdf').cardSurface);
  const compiled = (
    await compileShader(source, { id: 'card-contact-actual-world-observed' })
  ).unwrap();
  // Renderer passes the authored module directly to runtime.createShaderModule.
  // Retain Naga validation as a separate CPU gate rather than publishing a
  // second WGSL-writer representation into the Native pipeline path.
  await save('cardSurface.naga-validated.wgsl', new TextEncoder().encode(compiled.wgsl));
  await save('cardSurface.actual.wgsl', new TextEncoder().encode(source));
  await save(
    'module-start.json',
    new TextEncoder().encode(
      JSON.stringify({ stage: 'actual shader module request', entry: 'cardSurface' }),
    ),
  );
  const result = await compile(device, { code: source, label: 'card-contact.actual-world' });
  await save(
    'module-returned.json',
    new TextEncoder().encode(
      JSON.stringify({ ok: result.ok, error: result.ok ? null : String(result.error) }),
    ),
  );
  const module = result.unwrap();
  const original = device.createBindGroupLayout.bind(device);
  const spy = vi.spyOn(device, 'createBindGroupLayout').mockImplementation((desc) => {
    const entries = [...desc.entries];
    expect(entries.some((entry) => entry.binding === 17)).toBe(false);
    return original({
      ...desc,
      entries: [...entries, { binding: 17, visibility: 4, buffer: { type: 'storage' } }],
    });
  });
  try {
    await save(
      'pipeline-start.json',
      new TextEncoder().encode(
        JSON.stringify({ stage: 'actual factory pipeline request', entry: 'cardSurface' }),
      ),
    );
    const pending = createIrradianceFieldKernel(device, 'cardSurface', module, 'global-sdf');
    await save(
      'pipeline-promise.json',
      new TextEncoder().encode(JSON.stringify({ stage: 'actual factory returned its Promise' })),
    );
    const pipeline = await pending;
    await save(
      'pipeline-returned.json',
      new TextEncoder().encode(
        JSON.stringify({ ok: pipeline.ok, error: pipeline.ok ? null : String(pipeline.error) }),
      ),
    );
    return pipeline.unwrap();
  } finally {
    spy.mockRestore();
  }
}

async function plane(
  device: RhiDevice,
  texture: Texture,
  width: number,
  height: number,
  pixelBytes: number,
) {
  const stride = Math.ceil((width * pixelBytes) / 256) * 256;
  const buffer = device.createBuffer({ size: stride * height, usage: 12 }).unwrap();
  try {
    const encoder = device.createCommandEncoder({}).unwrap();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: stride }, { width, height });
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const padded = await readBuffer(device, buffer, stride * height),
      dense = new Uint8Array(width * height * pixelBytes);
    for (let y = 0; y < height; y++)
      dense.set(
        padded.subarray(y * stride, y * stride + width * pixelBytes),
        y * width * pixelBytes,
      );
    return dense;
  } finally {
    device.destroyBuffer(buffer);
  }
}

function decode(raw: Uint8Array, texels: number, selected: number) {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength),
    at = texels * 64 + selected * 96;
  const words = (offset: number) =>
    Array.from({ length: 4 }, (_, i) => view.getUint32(offset + i * 4, true));
  const floats = (offset: number) =>
    Array.from({ length: 4 }, (_, i) => view.getFloat32(offset + i * 4, true));
  return {
    mask: view.getUint32(selected * 64 + 12, true),
    valid: view.getUint32(selected * 64 + 28, true),
    control: words(at),
    state: words(at + 16),
    originLo: floats(at + 32),
    originHi: floats(at + 48),
    directionLo: floats(at + 64),
    directionHi: floats(at + 80),
  };
}

function maskImage(raw: Uint8Array, width: number, height: number) {
  const words = new Uint32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4),
    rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const valid = words[i * 16 + 7],
      mask = words[i * 16 + 3];
    rgba.set(
      valid === 0 ? [255, 0, 255, 255] : mask === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255],
      i * 4,
    );
  }
  return encodePng(width, height, rgba);
}

/** One real capture, one full World pipeline and retained same-source facts.
 * Missing/stale controls use the same geometry, capture and untouched uniforms. */
export async function verifyCardContactCapture(device: RhiDevice, compile: Compile, save: Save) {
  const fixture = await prepareCardContactCapture(),
    owned: Buffer[] = [];
  const buffer = (data: Uint8Array, usage: number) => {
    const value = device.createBuffer({ size: data.byteLength, usage: usage | 8 }).unwrap();
    owned.push(value);
    device.queue.writeBuffer(value, 0, data).unwrap();
    return value;
  };
  const bytes = (values: Float32Array | Uint32Array) =>
    new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  const capture = (
    await prepareSurfaceCapture(device, compile, [fixture.source], {
      kind: 'cards',
      resolution: fixture.resolution,
    })
  ).unwrap();
  try {
    const entry = capture.entry(0);
    assert(entry);
    const range = { first: entry.firstTile, count: entry.projections.length },
      tile = entry.firstTile + fixture.card;
    const expected = fixture.scene.sourceExpected;
    assert(expected);
    const first = device.createCommandEncoder({}).unwrap();
    capture.record(first, range).unwrap();
    capture
      .recordReceiverFacts(first, { expected, instances: fixture.instances }, range, range)
      .unwrap();
    device.queue.submit([first.finish().unwrap()]).unwrap();
    capture.commitReceiverCapture(range);
    const texels = capture.width * capture.height,
      columns = capture.width / fixture.resolution;
    const pixel = [
      (tile % columns) * fixture.resolution + fixture.pixel[0],
      Math.floor(tile / columns) * fixture.resolution + fixture.pixel[1],
    ];
    const selected = (pixel[1] ?? 0) * capture.width + (pixel[0] ?? 0);
    const id = await plane(
      device,
      capture.primitiveIndex.texture,
      capture.width,
      capture.height,
      4,
    );
    const albedo = await plane(
      device,
      capture.textures.albedoRoughness,
      capture.width,
      capture.height,
      8,
    );
    const depth = await plane(device, capture.textures.depth, capture.width, capture.height, 4);
    const normal = await plane(device, capture.textures.normals, capture.width, capture.height, 8);
    const emission = await plane(
      device,
      capture.textures.emissionMetallic,
      capture.width,
      capture.height,
      8,
    );
    const f0 = await plane(device, capture.textures.f0Validity, capture.width, capture.height, 8);
    const facts = await readBuffer(device, capture.receivers.buffer, capture.receivers.size);
    await save('capture-primitive.bin', id);
    await save('capture-albedo.bin', albedo);
    await save('capture-facts.bin', facts);
    await save('capture-depth.bin', depth);
    await save('capture-normal.bin', normal);
    await save('capture-emission.bin', emission);
    await save('capture-f0.bin', f0);
    const rgba = new Uint8Array(texels * 4);
    for (let i = 0; i < texels; i++)
      for (let channel = 0; channel < 4; channel++)
        rgba[i * 4 + channel] = Math.round(
          Math.min(1, Math.max(0, half(albedo, i * 8 + channel * 2))) * 255,
        );
    await save('capture-albedo.png', encodePng(capture.width, capture.height, rgba));
    expect(
      new DataView(id.buffer, id.byteOffset, id.byteLength).getUint32(selected * 4, true),
    ).toBe(0);
    expect(
      new DataView(depth.buffer, depth.byteOffset, depth.byteLength).getFloat32(selected * 4, true),
    ).toBe(fixture.expectedDepth);
    expect(Math.trunc(half(f0, selected * 8 + 6)) & 3).toBe(1);
    expect(facts.slice(tile * 160 + 32, tile * 160 + 96)).toEqual(fixture.expectedViewProjection);
    const packed = packCardLookupProjections(
      capture,
      [
        {
          instanceId: 0,
          key: rayGeometryKey(fixture.source.instance, fixture.source.layout.meshDigest),
        },
      ],
      [fixture.source],
    );
    const output = buffer(new Uint8Array(texels * 64), 128 | 4),
      witness = buffer(new Uint8Array(texels * 96), 128 | 4);
    const missing = buffer(new Uint8Array(capture.receivers.size), 128);
    const base: Partial<Record<IrradianceFieldKernelInput, Resource>> = {
      voxels: { buffer: buffer(fixture.scene.data.voxels, 128) },
      grid: { buffer: buffer(fixture.scene.data.settings, 64) },
      instances: { buffer: buffer(fixture.scene.data.instances, 128) },
      fields: { buffer: buffer(fixture.scene.data.fields, 128) },
      bounds: { buffer: buffer(fixture.scene.data.bounds, 128) },
      cards: { buffer: buffer(packed.bytes, 128) },
      cardSettings: { buffer: buffer(bytes(Uint32Array.of(packed.count, 0, 0, 0)), 64) },
      surfaces: { buffer: output },
      cardReceivers: { buffer: capture.receivers.buffer },
      cardPrimitiveIndex: capture.primitiveIndex.view,
      albedoRoughness: capture.views.albedoRoughness,
      normals: capture.views.normals,
      emissionMetallic: capture.views.emissionMetallic,
      f0Validity: capture.views.f0Validity,
      depth: capture.views.depth,
    };
    const kernel = await observedKernel(device, compile, save),
      records = [];
    const modes = [
      ...fixture.lights.map((light, index) => ({
        name: ['directional', 'point', 'spot', 'endpoint-before-blocker'][index] ?? 'light',
        light,
        expected: fixture.physicalMasks[index],
        valid: 1,
        query: 1,
      })),
      { name: 'missing-capture-facts', light: fixture.lights[1], expected: 0, valid: 0, query: 0 },
      { name: 'stale-source', light: fixture.lights[1], expected: 0, valid: 0, query: 0 },
    ];
    for (const mode of modes) {
      assert(mode.light);
      const light = new Float32Array(32 * 16);
      light.set([...mode.light.position, mode.light.kind]);
      light.set([1, 1, 1, 1], 4);
      light.set([...mode.light.direction, 4], 8);
      light.set([0.9, 0.5, 0, 0], 12);
      const query = new Uint8Array(8);
      new Uint32Array(query.buffer)[0] = 64;
      new Float32Array(query.buffer)[1] = 1;
      const frame = packIrradianceFieldFrame({
        probeBudget: 0,
        raysPerProbe: 1,
        frameIndex: 1,
        tileOffset: tile,
        tileBudget: 1,
        tileCount: packed.count,
        lightCount: 1,
        atlasWidth: capture.width,
        cardResolution: fixture.resolution,
        radiosity: false,
        environment: [0, 0, 0],
        hysteresis: 0,
        maxDistance: 4,
        surfaceBias: 0.25,
        depthClamp: 8,
        cardMargin: 0,
        gather: [0, 0, 0, 0],
        query,
        reflections: [0, 0],
        worldSource: {
          traversal: 'global-sdf',
          expected:
            mode.name === 'stale-source'
              ? [expected[0], expected[1], expected[2], expected[3] + 1]
              : expected,
        },
      });
      const resources = {
        ...base,
        lights: { buffer: buffer(bytes(light), 64) },
        frame: { buffer: buffer(frame, 64) },
        ...(mode.name === 'missing-capture-facts' ? { cardReceivers: { buffer: missing } } : {}),
      };
      const encoder = device.createCommandEncoder({}).unwrap();
      capture
        .recordReceiverFacts(encoder, { expected, instances: fixture.instances }, range)
        .unwrap();
      device.queue.writeBuffer(output, 0, new Uint8Array(texels * 64)).unwrap();
      device.queue.writeBuffer(witness, 0, new Uint8Array(texels * 96)).unwrap();
      const original = device.createBindGroup.bind(device),
        spy = vi.spyOn(device, 'createBindGroup').mockImplementation((desc) =>
          original({
            ...desc,
            entries: [
              ...desc.entries,
              { binding: 17, resource: { kind: 'buffer', value: { buffer: witness } } },
            ],
          }),
        );
      try {
        const pass = encoder.beginComputePass({});
        kernel
          .record(
            pass,
            (name) => {
              const value = resources[name];
              assert(value, name);
              return value;
            },
            fixture.resolution ** 2,
          )
          .unwrap();
        pass.end();
      } finally {
        spy.mockRestore();
      }
      const readback = buffer(new Uint8Array(texels * 160), 4);
      encoder.copyBufferToBuffer(output, 0, readback, 0, texels * 64);
      encoder.copyBufferToBuffer(witness, 0, readback, texels * 64, texels * 96);
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      const raw = await readBuffer(device, readback, texels * 160);
      await save(`${mode.name}.bin`, raw);
      await save(
        `${mode.name}.png`,
        maskImage(raw.subarray(0, texels * 64), capture.width, capture.height),
      );
      const record = { name: mode.name, ...decode(raw, texels, selected) };
      records.push(record);
      await save(
        'records.json',
        new TextEncoder().encode(
          JSON.stringify(
            {
              records,
              pixel,
              selected,
              point: fixture.point,
              expectedMasks: fixture.physicalMasks,
            },
            null,
            2,
          ),
        ),
      );
      expect(record.valid, mode.name).toBe(mode.valid);
      expect(record.mask, mode.name).toBe(mode.expected);
      expect(record.control[0], mode.name).toBe(mode.query);
      if (mode.query) {
        expect(record.control).toEqual([1, 64, 0, 0]);
        expect(record.state[2]).toBeLessThanOrEqual(64);
        for (let axis = 0; axis < 3; axis++) {
          const point = fixture.point[axis];
          assert(point !== undefined);
          expect(record.originLo[axis]).toBeLessThanOrEqual(point);
          expect(record.originHi[axis]).toBeGreaterThanOrEqual(point);
        }
        const directional = record.directionLo.slice(0, 3) as [number, number, number];
        const delta: V3 =
          mode.light.kind === 1
            ? directional
            : [
                mode.light.position[0] - fixture.point[0],
                mode.light.position[1] - fixture.point[1],
                mode.light.position[2] - fixture.point[2],
              ];
        for (let axis = 0; axis < 3; axis++) {
          const value = delta[axis];
          assert(value !== undefined);
          expect(record.directionLo[axis]).toBeLessThanOrEqual(value);
          expect(record.directionHi[axis]).toBeGreaterThanOrEqual(value);
        }
        expect(
          Number(
            !triangleOnSegment(
              fixture.point,
              delta,
              mode.light.kind === 1 ? 4 : 1,
              fixture.blocker,
            ),
          ),
        ).toBe(mode.expected);
        expect(record.originLo[3]).toBe(0);
        expect(record.originHi[3]).toBe(mode.light.kind === 1 ? 4 : 1);
        if (mode.expected === 0) {
          expect(record.state[0]).toBe(1);
          expect(record.state[3]).toBe(0);
          expect(((record.state[1] ?? 0) >>> 2) & 0x1fffff).toBe(1);
          expect((record.state[1] ?? 0) & 1).toBe(0);
        } else expect(record.state[0]).toBe(0);
      }
    }
    return {
      records,
      pixel,
      selected,
      point: fixture.point,
      width: capture.width,
      height: capture.height,
      tiles: packed.count,
      scope:
        'Actual Card capture and full software World local physical regression; not whole GI, hardware contact or performance acceptance.',
    };
  } finally {
    capture.dispose();
    for (const value of owned) device.destroyBuffer(value);
  }
}
