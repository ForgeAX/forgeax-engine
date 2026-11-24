import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, it } from 'vitest';
import { rebuildCardOwnerIndex } from '../../raytracing/card-owner-index';
import { packScreenProbeFrame, ScreenProbeRayStatus } from '../../raytracing/screen-probe-plan';
import {
  controlledCardFacingSource,
  packControlledCardFacingProbe,
} from './screen-probe-card-facing.fixture';

it('uses controlled Hits to verify the actual post-Hit Card facing, lookup and resolve suffix', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Actual GPU required');
  const device = await adapter.requestDevice(),
    owned: GPUBuffer[] = [],
    textures: GPUTexture[] = [],
    errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const buffer = (bytes: Uint8Array, usage = 128 | 8 | 4) => {
    const value = device.createBuffer({ size: bytes.byteLength, usage });
    owned.push(value);
    if (!(usage & 1)) device.queue.writeBuffer(value, 0, bytes);
    return value;
  };
  const floats = (values: number[], usage?: number) =>
    buffer(new Uint8Array(Float32Array.from(values).buffer), usage);
  const atlas = (values: number[]) => {
    const value = device.createTexture({ size: [2, 2], format: 'rgba32float', usage: 4 | 2 });
    textures.push(value);
    device.queue.writeTexture(
      { texture: value },
      Float32Array.from(values),
      { bytesPerRow: 32 },
      [2, 2],
    );
    return value;
  };
  const controls: unknown[] = [];
  device.pushErrorScope('validation');
  try {
    const hit = floats(new Array<number>(16).fill(0));
    const cards = buffer(new Uint8Array(80)),
      lit = floats(new Array<number>(16).fill(0));
    const ray = buffer(new Uint8Array(64 * 32)),
      probe = buffer(packControlledCardFacingProbe());
    const frame = buffer(
      packScreenProbeFrame({
        worldSource: { traversal: 'unused' },
        layout: {
          width: 4,
          height: 4,
          tilesX: 1,
          tilesY: 1,
          uniformCount: 1,
          adaptiveCapacity: 0,
          probeCount: 1,
        },
        downsample: 4,
        frameIndex: 0,
        importance: 'uniform',
        screenSteps: 0,
        thickness: 0.02,
        environment: [0, 0, 0],
        maxDistance: 100,
        shortRangeAo: 0,
        maxFrames: 8,
        sceneHistory: false,
        pixelHistory: false,
        probeHistory: false,
        worldBias: 0.25,
        cardMargin: 0.125,
        query: new Uint8Array(8),
        reprojection: undefined,
      }),
      64 | 8,
    );
    const settings = buffer(new Uint8Array(Uint32Array.from([1, 2, 0, 0]).buffer), 64 | 8);
    const white = atlas(new Array<number>(16).fill(1)),
      normal = atlas(new Array<number>(16).fill(0));
    const depth = device.createTexture({ size: [2, 2], format: 'depth32float', usage: 4 | 16 });
    textures.push(depth);
    const clear = device.createCommandEncoder();
    clear
      .beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: depth.createView(),
          depthClearValue: 0,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      })
      .end();
    device.queue.submit([clear.finish()]);
    const layout = device.createBindGroupLayout({
      entries: [
        ...[0, 5, 6, 8].map((binding) => ({
          binding,
          visibility: 4,
          buffer: { type: 'read-only-storage' as const },
        })),
        { binding: 7, visibility: 4, buffer: { type: 'storage' } },
        ...[9, 10].map((binding) => ({
          binding,
          visibility: 4,
          buffer: { type: 'uniform' as const },
        })),
        ...[11, 12, 13, 14].map((binding) => ({
          binding,
          visibility: 4,
          texture: { sampleType: 'unfilterable-float' as const },
        })),
        { binding: 15, visibility: 4, texture: { sampleType: 'depth' } },
      ],
    });
    const group = device.createBindGroup({
      layout,
      entries: [
        ...[
          [0, hit],
          [5, cards],
          [6, lit],
          [7, ray],
          [8, probe],
          [9, frame],
          [10, settings],
        ].map(([binding, value]) => ({
          binding: binding as number,
          resource: { buffer: value as GPUBuffer },
        })),
        ...[
          [11, white],
          [12, normal],
          [13, white],
          [14, white],
          [15, depth],
        ].map(([binding, value]) => ({
          binding: binding as number,
          resource: (value as GPUTexture).createView(),
        })),
      ],
    });
    const staging = buffer(new Uint8Array(64 * 32), 1 | 8);
    const incoming = [0.6265441179275513, 0.0528193935751915, 0.7775940299034119];
    const coarse = [-0.7686999440193176, 0, 0.639609694480896];
    for (const exact of [false, true]) {
      const { source, identity } = controlledCardFacingSource(exact);
      const pipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: {
          module: device.createShaderModule({ code: source }),
          entryPoint: 'traceWorldProbes',
        },
      });
      const cases = [
        {
          name: 'captured-coarse-backface',
          coarse,
          geometric: -1,
          shading: -1,
          lit: true,
          expected: exact ? [0, 0, 0] : [0.1, 0.6, 4],
          status: 0,
        },
        {
          name: 'coarse-front-geometric-back',
          coarse: [0.51, 0, -Math.sqrt(1 - 0.51 ** 2)],
          geometric: 1,
          shading: 1,
          lit: true,
          expected: exact ? [0.1, 0.6, 4] : [0, 0, 0],
          status: 0,
        },
        {
          name: 'normal-mapped-front',
          coarse: [-1, 0, 0],
          geometric: -1,
          shading: 1,
          lit: true,
          expected: [0.1, 0.6, 4],
          status: 0,
        },
        {
          name: 'front-lighting-unavailable',
          coarse,
          geometric: -1,
          shading: -1,
          lit: false,
          expected: [0, 0, 0],
          status: exact ? 0 : 2,
        },
        {
          name: 'back-lighting-unavailable',
          coarse: [0.51, 0, -Math.sqrt(1 - 0.51 ** 2)],
          geometric: 1,
          shading: 1,
          lit: false,
          expected: [0, 0, 0],
          status: exact ? 2 : 0,
        },
      ];
      for (const control of cases) {
        const hitBytes = new Uint8Array(64);
        new Uint32Array(hitBytes.buffer).set([1, 0, 1, 7]);
        new Float32Array(hitBytes.buffer).set(
          [4.2785416, 0, 0, 1, 0, 0, 0, 1, ...control.coarse, 0],
          4,
        );
        device.queue.writeBuffer(hit, 0, hitBytes);
        const cardBytes = new Uint8Array(80);
        new Float32Array(cardBytes.buffer).set([
          0,
          -1,
          -1,
          0,
          0,
          1,
          0,
          2,
          0,
          0,
          1,
          2,
          control.geometric,
          0,
          0,
          1,
        ]);
        new Uint32Array(cardBytes.buffer).set([7, 1, 0, 0], 16);
        rebuildCardOwnerIndex(cardBytes, 1);
        device.queue.writeBuffer(cards, 0, cardBytes);
        device.queue.writeTexture(
          { texture: normal },
          Float32Array.from(
            Array.from({ length: 4 }, () => [control.shading, 0, control.geometric, 0]).flat(),
          ),
          { bytesPerRow: 32 },
          [2, 2],
        );
        device.queue.writeBuffer(
          lit,
          0,
          Float32Array.from(
            Array.from({ length: 4 }, () => [0.1, 0.6, 4, Number(control.lit)]).flat(),
          ),
        );
        const rayBytes = new Uint8Array(64 * 32);
        new Float32Array(rayBytes.buffer).set(incoming);
        new Uint32Array(rayBytes.buffer)[3] = (ScreenProbeRayStatus.world << 12) | 512;
        device.queue.writeBuffer(ray, 0, rayBytes);
        const encoder = device.createCommandEncoder(),
          pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(1);
        pass.end();
        encoder.copyBufferToBuffer(ray, 0, staging, 0, staging.size);
        device.queue.submit([encoder.finish()]);
        const validation = await device.popErrorScope();
        device.pushErrorScope('validation');
        if (validation) {
          errors.push(validation.message);
          throw new Error(validation.message);
        }
        await staging.mapAsync(1);
        const mapped = staging.getMappedRange();
        const actual = new Float32Array(mapped).slice(0, 8),
          status = (new Uint32Array(mapped)[3] ?? 0) >>> 12;
        staging.unmap();
        controls.push({
          sourceScope: identity,
          exact,
          ...control,
          actual: Array.from(actual.slice(4, 7)),
          actualStatus: status,
          sourceSha256: createHash('sha256').update(source).digest('hex'),
        });
      }
    }
    expect(errors).toEqual([]);
    for (const row of controls as {
      expected: number[];
      actual: number[];
      status: number;
      actualStatus: number;
    }[]) {
      expect(row.actualStatus & 7).toBe(row.status);
      row.expected.forEach((value, i) => {
        expect(row.actual[i]).toBeCloseTo(value, 5);
      });
    }
  } finally {
    const remainingValidation = await device.popErrorScope();
    if (remainingValidation) errors.push(remainingValidation.message);
    const out = process.env.FORGEAX_GI_BACKFACE_RESULT ?? 'artifacts/screen-probe/card-facing.json';
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(
      out,
      JSON.stringify(
        {
          scope:
            'Actual production world consumer and Card texture lookup, controlled Hit producer calibrated from the captured ellipsoid failure. This isolates facing and lighting readiness; it is not full world traversal or native Ray Query acceptance.',
          controls,
          errors,
          adapter: { vendor: adapter.info.vendor, device: adapter.info.device },
        },
        null,
        2,
      ),
    );
    for (const value of owned) value.destroy();
    for (const value of textures) value.destroy();
    device.destroy();
  }
}, 30000);
