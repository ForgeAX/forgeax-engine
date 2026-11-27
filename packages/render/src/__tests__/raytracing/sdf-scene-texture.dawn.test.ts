import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RhiDevice, Texture } from '@forgeax/engine-rhi';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { equalBytes } from '../../../../../scripts/test/byte-equality.mjs';
import { compileShader } from '../../../../shader-compiler/src/index';
import {
  createSdfSceneTextureKernel,
  invalidateSdfSceneTexture,
  packSdfSceneTexture,
  planSdfSceneTexture,
  SDF_SCENE_TEXTURE_PROJECT_WGSL,
  type SdfSceneTexturePlan,
} from '../../raytracing/sdf-scene-texture';

async function readProjection(device: RhiDevice, texture: Texture, plan: SdfSceneTexturePlan) {
  const stride = Math.ceil((plan.width * 16) / 256) * 256;
  const staging = device.createBuffer({ size: stride * plan.height, usage: 9 }).unwrap();
  try {
    const encoder = device.createCommandEncoder({}).unwrap();
    encoder.copyTextureToBuffer(
      { texture },
      { buffer: staging, bytesPerRow: stride, rowsPerImage: plan.height },
      { width: plan.width, height: plan.height },
    );
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const mapped = (await staging.mapAsync(1)).unwrap();
    const raw = new Uint8Array(mapped.getMappedRange().unwrap()).slice();
    mapped.unmap();
    const packed = new Uint8Array(plan.bytes);
    for (let row = 0; row < plan.height; row++)
      packed.set(raw.subarray(row * stride, row * stride + plan.width * 16), row * plan.width * 16);
    return packed;
  } finally {
    device.destroyBuffer(staging).unwrap();
  }
}

function expectedProjection(
  plan: SdfSceneTexturePlan,
  instances: Uint32Array,
  fields: Uint32Array,
  epoch: number,
  rowLimit: number,
) {
  const words = new Uint32Array(plan.texels * 4);
  words.set([
    0x46585354,
    1,
    epoch,
    1,
    16,
    instances.length,
    16 + instances.length,
    fields.length,
    rowLimit,
    36,
    plan.width,
    plan.height,
    16 + instances.length + fields.length,
    0,
    0,
    0,
  ]);
  words.set(instances, 16);
  words.set(fields, 88);
  return new Uint8Array(words.buffer);
}

it('projects actual canonical raw words, offsets and edit invalidation without FP reinterpretation', async () => {
  const device = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const raw = device.nativeDevice().unwrap();
  if (raw === undefined) throw new Error('Raw scene projection requires an actual device');
  const info = raw.adapterInfo;
  const adapter =
    info === undefined
      ? null
      : {
          vendor: info.vendor,
          architecture: info.architecture,
          device: info.device,
          description: info.description,
        };
  if (
    adapter === null ||
    ![adapter.vendor, adapter.device, adapter.description].some(
      (value) => typeof value === 'string' && value.length > 0,
    )
  )
    throw new Error('Raw projection requires explicit actual adapter identity');
  const errors: string[] = [];
  raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const source = (
    await compileShader(SDF_SCENE_TEXTURE_PROJECT_WGSL, { id: 'sdf-scene-project' })
  ).unwrap();
  const module = (await webgpu.createShaderModule(device, { code: source.wgsl })).unwrap();
  const kernel = (await createSdfSceneTextureKernel(device, module)).unwrap();
  const anchor = 'if(field<source.y){return sourceFields[field];}';
  expect(SDF_SCENE_TEXTURE_PROJECT_WGSL.split(anchor).length).toBe(2);
  const wrongSource = SDF_SCENE_TEXTURE_PROJECT_WGSL.replace(
    anchor,
    'if(field<source.y){let word=sourceFields[field];let magnitude=word&0x7fffffffu;return select(word,word&0x80000000u,magnitude>0u&&magnitude<0x00800000u);}',
  );
  const wrongCode = (
    await compileShader(wrongSource, { id: 'sdf-scene-projection-ftz-control' })
  ).unwrap().wgsl;
  const wrongModule = (await webgpu.createShaderModule(device, { code: wrongCode })).unwrap();
  const wrongKernel = (await createSdfSceneTextureKernel(device, wrongModule)).unwrap();
  const wrongControls = [
    ['capacity-is-row-limit', 'vec4u(source.z,', 'vec4u(source.x/36u,'],
    ['skip-tail', 'if(texel>=texels){return;}', 'if(texel>=texels || texel*4u>=shape.z){return;}'],
  ] as const;
  const controls = [];
  for (const [name, before, after] of wrongControls) {
    expect(SDF_SCENE_TEXTURE_PROJECT_WGSL.split(before).length).toBe(2);
    const code = (
      await compileShader(SDF_SCENE_TEXTURE_PROJECT_WGSL.replace(before, after), { id: name })
    ).unwrap().wgsl;
    const shader = (await webgpu.createShaderModule(device, { code })).unwrap();
    controls.push({ name, kernel: (await createSdfSceneTextureKernel(device, shader)).unwrap() });
  }
  const directory =
    process.env.FORGEAX_SDF_SCENE_TEXTURE_OUTPUT ??
    join(tmpdir(), `forgeax-sdf-scene-${process.pid}`);
  mkdirSync(directory, { recursive: true });
  const results: { offset: number; epoch: number; phase: string; bytes: number }[] = [];
  try {
    for (const prefix of [0, 64]) {
      const instanceWords = Uint32Array.from({ length: 72 }, (_, i) => (i * 2654435761) >>> 0);
      const fieldWords = Uint32Array.from(
        { length: prefix === 0 ? 7 : 4103 },
        (_, i) => (i * 2246822519) >>> 0,
      );
      fieldWords.set([1, 0x80000000, 0x7fc00001, 0x7f800000, 0x3f800000, 0xfffffff0, 0]);
      const rowLimit = prefix === 0 ? 1 : 2;
      const plan = planSdfSceneTexture(288, fieldWords.byteLength, rowLimit, {
        maxTextureDimension2D: prefix === 0 ? 8 : 1024,
        maxBytes: prefix === 0 ? 384 : 32768,
      }).unwrap();
      expect([plan.width, plan.height]).toEqual(prefix === 0 ? [8, 3] : [1024, 2]);
      const instanceBacking = new Uint32Array(prefix + 72 + 4).fill(0xdeadbeef);
      const fieldBacking = new Uint32Array(prefix + fieldWords.length + 5).fill(0xa5a5a5a5);
      instanceBacking.set(instanceWords, prefix);
      fieldBacking.set(fieldWords, prefix);
      const instances = device
        .createBuffer({ size: instanceBacking.byteLength, usage: 140 })
        .unwrap();
      const fields = device.createBuffer({ size: fieldBacking.byteLength, usage: 140 }).unwrap();
      const params = device.createBuffer({ size: 32, usage: 76 }).unwrap();
      const texture = device
        .createTexture({
          size: { width: plan.width, height: plan.height },
          format: 'rgba32uint',
          usage: 15,
        })
        .unwrap();
      try {
        device.queue.writeBuffer(instances, 0, instanceBacking).unwrap();
        device.queue.writeBuffer(fields, 0, fieldBacking).unwrap();
        const output = device.createTextureView(texture, { dimension: '2d' }).unwrap();
        const prefill = () =>
          device.queue
            .writeTexture(
              { texture },
              new Uint32Array(plan.texels * 4).fill(0xdeadbeef),
              { bytesPerRow: plan.width * 16, rowsPerImage: plan.height },
              { width: plan.width, height: plan.height },
            )
            .unwrap();
        const project = (epoch: number, selected = kernel, override?: Uint32Array) => {
          device.queue
            .writeBuffer(params, 0, override ?? packSdfSceneTexture(plan, epoch).unwrap())
            .unwrap();
          const encoder = device.createCommandEncoder({}).unwrap();
          const pass = encoder.beginComputePass({ label: 'sdf-scene-raw-projection' });
          selected
            .record(
              pass,
              {
                instances: { buffer: instances, offset: prefix * 4, size: 288 },
                fields: { buffer: fields, offset: prefix * 4, size: fieldWords.byteLength },
              },
              { buffer: params, size: 32 },
              output,
              plan,
            )
            .unwrap();
          pass.end();
          device.queue.submit([encoder.finish().unwrap()]).unwrap();
        };
        prefill();
        invalidateSdfSceneTexture(device, texture, 1).unwrap();
        project(1);
        const first = await readProjection(device, texture, plan);
        expect(
          equalBytes(first, expectedProjection(plan, instanceWords, fieldWords, 1, rowLimit)),
        ).toBe(true);
        writeFileSync(join(directory, `offset-${prefix}-epoch-1.bin`), first);
        results.push({ offset: prefix, epoch: 1, phase: 'complete', bytes: first.byteLength });
        invalidateSdfSceneTexture(device, texture, 2).unwrap();
        instanceWords[48] = 0x00800001;
        fieldWords[0] = 0x80000001;
        device.queue.writeBuffer(instances, prefix * 4, instanceWords).unwrap();
        device.queue.writeBuffer(fields, prefix * 4, fieldWords).unwrap();
        const pending = await readProjection(device, texture, plan);
        const header = new Uint32Array(pending.buffer, pending.byteOffset, 4);
        expect(Array.from(header)).toEqual([0x46585354, 1, 2, 0]);
        writeFileSync(join(directory, `offset-${prefix}-invalidated.bin`), pending);
        results.push({
          offset: prefix,
          epoch: 2,
          phase: 'invalidated-before-copy',
          bytes: pending.byteLength,
        });
        project(2);
        const edited = await readProjection(device, texture, plan);
        expect(
          equalBytes(edited, expectedProjection(plan, instanceWords, fieldWords, 2, rowLimit)),
        ).toBe(true);
        writeFileSync(join(directory, `offset-${prefix}-epoch-2.bin`), edited);
        results.push({ offset: prefix, epoch: 2, phase: 'complete', bytes: edited.byteLength });
        project(3, wrongKernel);
        const wrong = await readProjection(device, texture, plan);
        expect(
          equalBytes(wrong, expectedProjection(plan, instanceWords, fieldWords, 3, rowLimit)),
        ).toBe(false);
        expect(new Uint32Array(wrong.buffer, wrong.byteOffset)[88]).toBe(0x80000000);
        writeFileSync(join(directory, `offset-${prefix}-wrong-ftz.bin`), wrong);
        results.push({
          offset: prefix,
          epoch: 3,
          phase: 'controlled-ftz-is-wrong',
          bytes: wrong.byteLength,
        });
        for (const [i, control] of controls.entries()) {
          const epoch = 4 + i;
          prefill();
          invalidateSdfSceneTexture(device, texture, epoch).unwrap();
          project(epoch, control.kernel);
          const actual = await readProjection(device, texture, plan);
          const differs = !equalBytes(
            actual,
            expectedProjection(plan, instanceWords, fieldWords, epoch, rowLimit),
          );
          expect(differs).toBe(control.name === 'skip-tail' ? prefix === 64 : prefix === 0);
          writeFileSync(join(directory, `offset-${prefix}-${control.name}.bin`), actual);
          results.push({ offset: prefix, epoch, phase: control.name, bytes: actual.byteLength });
        }
        for (const [index, value, name] of [
          [0, 73, 'misaligned-instance-span'],
          [1, fieldWords.length + 1, 'field-span-past-binding'],
          [2, 3, 'row-limit-past-capacity'],
          [3, 0, 'unaccepted-zero-epoch'],
          [4, plan.width + 1, 'wrong-texture-shape'],
          [6, plan.logicalWords + 1, 'wrong-logical-size'],
          [7, 1, 'nonzero-reserved-word'],
        ] as const) {
          const epoch = 6;
          const invalid = packSdfSceneTexture(plan, epoch).unwrap();
          invalid[index] = value;
          prefill();
          invalidateSdfSceneTexture(device, texture, epoch).unwrap();
          const before = await readProjection(device, texture, plan);
          project(epoch, kernel, invalid);
          const actual = await readProjection(device, texture, plan);
          expect(equalBytes(before, actual)).toBe(true);
          expect(Array.from(new Uint32Array(actual.buffer, actual.byteOffset, 4))).toEqual([
            0x46585354,
            1,
            epoch,
            0,
          ]);
          writeFileSync(join(directory, `offset-${prefix}-rejected-${name}.bin`), actual);
          results.push({
            offset: prefix,
            epoch,
            phase: `rejected-${name}`,
            bytes: actual.byteLength,
          });
        }
      } finally {
        device.destroyTexture(texture);
        for (const buffer of [instances, fields, params]) device.destroyBuffer(buffer);
      }
    }
    await device.queue.onSubmittedWorkDone();
    expect(errors).toEqual([]);
  } finally {
    writeFileSync(
      join(directory, 'receipt.json'),
      JSON.stringify(
        {
          adapter,
          results,
          errors,
          scope:
            'Raw-word projection and explicit invalidation writes only; not a geometry eligibility certificate or a live shared-sampler/GI/World/performance acceptance.',
        },
        null,
        2,
      ),
    );
  }
}, 60_000);
