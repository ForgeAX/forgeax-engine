import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { WORLD_CARD_RADIANCE_WGSL } from '../../raytracing/world-traversal';
import {
  type CardResidencyOwnerCase,
  cardResidencyOwnerAdditionalCases,
  cardResidencyOwnerCases,
  cardResidencyOwnerInputs,
  cardResidencyOwnerKernel,
  cardResidencyOwnerOracle,
} from './card-residency-owner-index.fixture';

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

async function runCardResidencyOwnerCases(
  cases: readonly CardResidencyOwnerCase[],
  fault: true | 'break-stale',
  negativeName: string,
  expectedWrong: readonly number[],
) {
  const negativeCase = cases.find((test) => test.name === negativeName);
  if (!negativeCase) throw new Error('Missing actual unlit negative control');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('Real GPU adapter required');
  const actualAdapter = {
    vendor: adapter.info.vendor,
    architecture: adapter.info.architecture,
    device: adapter.info.device,
    description: adapter.info.description,
  };
  if (process.env.FORGEAX_CARD_RESIDENCY_REQUIRED_ADAPTER) {
    const required = JSON.parse(process.env.FORGEAX_CARD_RESIDENCY_REQUIRED_ADAPTER);
    expect(actualAdapter).toEqual(required);
  }
  const device = await adapter.requestDevice();
  const buffers: GPUBuffer[] = [],
    textures: GPUTexture[] = [],
    errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const lost = device.lost.then((info) => {
    if (info.reason !== 'destroyed') errors.push(`Device lost: ${info.reason}: ${info.message}`);
  });
  const buffer = (data: Uint8Array, usage = 128) => {
    const value = device.createBuffer({ size: data.byteLength, usage: usage | 8 });
    device.queue.writeBuffer(value, 0, data);
    buffers.push(value);
    return value;
  };
  const width = 128,
    height = 64;
  const texture = (pixel: readonly number[]) => {
    const data = new Float32Array(width * height * 4);
    for (let i = 0; i < width * height; i++) data.set(pixel, i * 4);
    const value = device.createTexture({
      size: [width, height],
      format: 'rgba32float',
      usage: 4 | 2,
    });
    device.queue.writeTexture({ texture: value }, data, { bytesPerRow: width * 16 }, [
      width,
      height,
    ]);
    textures.push(value);
    return value.createView();
  };
  const lighting = (available: boolean) => {
    const values = new Float32Array(width * height * 4);
    for (let i = 0; i < width * height; i++) values.set([2, 3, 5, Number(available)], i * 4);
    return buffer(new Uint8Array(values.buffer));
  };
  const code = cardResidencyOwnerKernel(),
    mutantCode = cardResidencyOwnerKernel(fault);
  let raw: Uint8Array | undefined;
  let failure: unknown;
  const inputs: { name: string; cards: string; query: string; settings: string }[] = [];
  try {
    const pipeline = async (source: string) => {
      const module = device.createShaderModule({ code: source });
      const messages = (await module.getCompilationInfo()).messages.filter(
        (m) => m.type === 'error',
      );
      if (messages.length) throw new Error(messages.map((m) => m.message).join('\n'));
      return device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module, entryPoint: 'main' },
      });
    };
    const actual = await pipeline(code),
      wrong = await pipeline(mutantCode);
    const output = buffer(new Uint8Array(32), 128 | 4);
    const readback = device.createBuffer({ size: (cases.length + 1) * 32, usage: 1 | 8 });
    buffers.push(readback);
    const depth = device.createTexture({
      size: [width, height],
      format: 'depth32float',
      usage: 16 | 4,
    });
    textures.push(depth);
    const views = [
      texture([1, 1, 1, 1]),
      texture([0, 0, 0, 0]),
      texture([0, 0, 0, 0]),
      texture([0, 0, 0, 1]),
      depth.createView(),
    ];
    const available = lighting(true),
      unavailable = lighting(false);
    const encoder = device.createCommandEncoder();
    encoder
      .beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: views[4] as GPUTextureView,
          depthClearValue: 0,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      })
      .end();
    const entries: GPUBindGroupEntry[][] = [];
    const dispatch = (pso: GPUComputePipeline, resources: GPUBindGroupEntry[], index: number) => {
      const group = device.createBindGroup({
        layout: pso.getBindGroupLayout(0),
        entries: resources,
      });
      const pass = encoder.beginComputePass();
      pass.setPipeline(pso);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(1);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, index * 32, 32);
    };
    for (const [index, test] of cases.entries()) {
      const data = cardResidencyOwnerInputs(test);
      inputs.push({
        name: test.name,
        cards: sha(data.cards),
        query: sha(data.query),
        settings: sha(data.settings),
      });
      const resources: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: test.lit ? available : unavailable } },
        { binding: 1, resource: { buffer: buffer(data.cards) } },
        { binding: 2, resource: { buffer: buffer(data.settings, 64) } },
        ...views.map((resource, i) => ({ binding: i + 3, resource })),
        { binding: 8, resource: { buffer: output } },
        { binding: 9, resource: { buffer: buffer(data.query, 64) } },
      ];
      entries.push(resources);
      dispatch(actual, resources, index);
    }
    const negative = entries[cases.indexOf(negativeCase)];
    if (!negative) throw new Error('Missing actual unlit negative control');
    dispatch(wrong, negative, cases.length);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(1);
    raw = new Uint8Array(readback.getMappedRange().slice(0));
    readback.unmap();
    await device.queue.onSubmittedWorkDone();
  } catch (cause) {
    failure = cause;
  } finally {
    for (const value of buffers) value.destroy();
    for (const value of textures) value.destroy();
    device.destroy();
    await lost;
  }
  if (failure) throw failure;
  if (!raw) throw new Error('Actual residency readback required');
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const records = cases.map((test, index) => ({
    name: test.name,
    count: test.owners.length,
    expected: cardResidencyOwnerOracle(test),
    actual: Array.from({ length: 4 }, (_, word) => view.getFloat32(index * 32 + word * 4, true)),
    directoryIterations: view.getUint32(index * 32 + 16, true),
    lookupVisits: view.getUint32(index * 32 + 20, true),
    pendingVisits: view.getUint32(index * 32 + 24, true),
  }));
  const wrongActual = Array.from({ length: 4 }, (_, word) =>
    view.getFloat32(cases.length * 32 + word * 4, true),
  );
  const result = {
    scope:
      'Controlled query association; actual complete Card consumer, not physical traversal or scene GI',
    adapter: actualAdapter,
    productionSHA256: sha(WORLD_CARD_RADIANCE_WGSL),
    kernelSHA256: sha(code),
    mutantSHA256: sha(mutantCode),
    rawSHA256: sha(raw),
    dispatches: cases.length + 1,
    inputs,
    records,
    wrongUnlitActual: wrongActual,
    fault,
    errors,
  };
  const destination = process.env.FORGEAX_CARD_RESIDENCY_RESULT;
  if (destination) {
    writeFileSync(`${destination}.raw.bin`, raw);
    writeFileSync(destination, JSON.stringify(result, null, 2));
  }
  expect(errors).toEqual([]);
  for (const row of records) expect(row.actual, row.name).toEqual(row.expected.rgba);
  expect(wrongActual).toEqual(expectedWrong);
  expect(wrongActual).not.toEqual(cardResidencyOwnerOracle(negativeCase).rgba);
  for (const row of records)
    expect(row.pendingVisits, row.name).toBeLessThanOrEqual(row.expected.pendingBound);
}

it('bounds pending residency checks by admitted owner chains while preserving black and unlit results', async () => {
  await runCardResidencyOwnerCases(cardResidencyOwnerCases(), true, 'stale-only', [0, 0, 0, 0]);
}, 30_000);

it('preserves resident fallback after stale rows and within the logical owner directory domain', async () => {
  await runCardResidencyOwnerCases(
    cardResidencyOwnerAdditionalCases(),
    'break-stale',
    'stale-before-outside-valid',
    [0, 0, 0, -1],
  );
}, 30_000);
