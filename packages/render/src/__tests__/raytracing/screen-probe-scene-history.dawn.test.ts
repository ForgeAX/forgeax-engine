import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import { SCREEN_PROBE_BINDINGS, SCREEN_PROBE_STAGES } from '../../raytracing/screen-probe-kernels';
import {
  packScreenProbeFrame,
  SCREEN_PROBE_FRAME_BYTES,
  SCREEN_PROBE_RECORD_BYTES,
} from '../../raytracing/screen-probe-plan';
import { VIEW_UNIFORM_BYTES } from '../../record/view-ubo';
import { gbufferNormalPixels } from './gbuffer-normal.fixture';
import { rayShaderTestImports } from './ray-shader-imports.fixture';
import { sceneHistoryCases } from './screen-probe-scene-history.fixture';

const projection = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function resourcesFor(device: GPUDevice) {
  const owned: (GPUBuffer | GPUTexture)[] = [];
  const make = (size: number, usage: number) => {
    const buffer = device.createBuffer({ size, usage });
    owned.push(buffer);
    return buffer;
  };
  const frame = make(SCREEN_PROBE_FRAME_BYTES, 64 | 8),
    view = make(VIEW_UNIFORM_BYTES, 64 | 8);
  const probes = make(SCREEN_PROBE_RECORD_BYTES, 128 | 8),
    rays = make(64 * 32, 128 | 8 | 4);
  const previous = make(16 * 16 * 8, 128 | 8 | 4);
  const output = make(64 * 32, 1 | 8),
    copied = make(previous.size, 1 | 8);
  const depth = device.createTexture({ size: [16, 16], format: 'depth32float', usage: 4 | 16 });
  const normal = device.createTexture({ size: [16, 16], format: 'rg32uint', usage: 4 | 2 });
  const pyramid = device.createTexture({ size: [16, 16], format: 'r32float', usage: 4 | 2 });
  const color = device.createTexture({ size: [16, 16], format: 'rgba16float', usage: 4 | 2 });
  const reflection = device.createTexture({ size: [16, 16], format: 'rgba16float', usage: 4 | 2 });
  owned.push(depth, normal, pyramid, color, reflection);
  const vf = new Float32Array(VIEW_UNIFORM_BYTES / 4);
  vf.set(projection);
  vf.set(projection, 44);
  vf.set([0, 0, 1], 24);
  vf.set([0, 1, 1, 0], 228);
  device.queue.writeBuffer(view, 0, vf);
  const record = new Float32Array(SCREEN_PROBE_RECORD_BYTES / 4);
  record.set([0, 0, 0.75, 1, 1, 0, 0]);
  device.queue.writeBuffer(probes, 0, record);
  device.queue.writeTexture(
    { texture: normal },
    gbufferNormalPixels(256),
    { bytesPerRow: 128 },
    [16, 16],
  );
  device.queue.writeTexture(
    { texture: pyramid },
    new Float32Array(256).fill(0.5),
    { bytesPerRow: 64 },
    [16, 16],
  );
  const clear = device.createCommandEncoder();
  clear
    .beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: depth.createView(),
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        depthClearValue: 0.5,
      },
    })
    .end();
  device.queue.submit([clear.finish()]);
  return {
    frame,
    rays,
    previous,
    output,
    copied,
    color,
    reflection,
    slots: {
      frame,
      view,
      probesIn: probes,
      rays,
      previousScene: previous,
      previousSceneOut: previous,
      scene: color.createView(),
      directionalReflection: reflection.createView(),
      depth: depth.createView(),
      normal: normal.createView(),
      depthPyramid: pyramid.createView(),
    },
    dispose: () => {
      for (const resource of owned) resource.destroy();
    },
  };
}

async function kernel(
  device: GPUDevice,
  stage: 'copySceneHistory' | 'copyDiffuseSceneHistory' | 'traceScreenProbes',
  code: string,
  resources: Record<string, GPUBuffer | GPUTextureView>,
) {
  const slots = SCREEN_PROBE_STAGES[stage].slots;
  const layout = device.createBindGroupLayout({
    entries: slots.map((slot) => {
      const [binding, kind] = SCREEN_PROBE_BINDINGS[slot];
      if (kind === 'depth' || kind === 'uint' || kind === 'float')
        return {
          binding,
          visibility: 4,
          texture: { sampleType: kind === 'float' ? ('unfilterable-float' as const) : kind },
        };
      return {
        binding,
        visibility: 4,
        buffer: {
          type:
            kind === 'uniform'
              ? ('uniform' as const)
              : kind === 'storage'
                ? ('storage' as const)
                : ('read-only-storage' as const),
        },
      };
    }),
  });
  const group = device.createBindGroup({
    layout,
    entries: slots.map((slot) => {
      const value = resources[slot];
      if (!value) throw new Error(`Missing actual ${slot}`);
      return {
        binding: SCREEN_PROBE_BINDINGS[slot][0],
        resource: 'mapAsync' in value ? { buffer: value } : value,
      };
    }),
  });
  const pipeline = await device.createComputePipelineAsync({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    compute: { module: device.createShaderModule({ code }), entryPoint: stage },
  });
  return { group, pipeline };
}

function frameData(history: boolean, steps: number) {
  return packScreenProbeFrame({
    worldSource: { traversal: 'unused' },
    layout: {
      width: 16,
      height: 16,
      tilesX: 1,
      tilesY: 1,
      uniformCount: 1,
      adaptiveCapacity: 0,
      probeCount: 1,
    },
    downsample: 16,
    frameIndex: 1,
    importance: 'uniform',
    screenSteps: steps,
    thickness: 0.02,
    environment: [0, 0, 0],
    maxDistance: 4,
    shortRangeAo: 0,
    maxFrames: 8,
    sceneHistory: history,
    pixelHistory: false,
    probeHistory: false,
    worldBias: 0.25,
    cardMargin: 0,
    query: new Uint8Array(8),
    reprojection: { viewProjection: projection, cameraPosition: [0, 0, 1] },
  });
}

async function mappedBytes(buffer: GPUBuffer) {
  await buffer.mapAsync(1);
  try {
    return new Uint8Array(buffer.getMappedRange().slice(0));
  } finally {
    buffer.unmap();
  }
}

it('keeps invalid retained HDR unresolved through copySceneHistory and traceScreenProbes without losing known black or half max', async () => {
  const source = readFileSync(
    new URL('../../../../shader/src/ray-screen-probe.wgsl', import.meta.url),
    'utf8',
  );
  const imports = await rayShaderTestImports();
  const copyCompiled = (
    await compileShader(source, {
      id: 'scene-history-copy',
      computeEntry: 'copySceneHistory',
      imports,
    })
  ).unwrap();
  const diffuseCopyCompiled = (
    await compileShader(source, {
      id: 'scene-history-diffuse-copy',
      computeEntry: 'copyDiffuseSceneHistory',
      imports,
    })
  ).unwrap();
  const traceCompiled = (
    await compileShader(source, {
      id: 'scene-history-trace',
      computeEntry: 'traceScreenProbes',
      imports,
    })
  ).unwrap();
  const directory =
    process.env.FORGEAX_SCENE_HISTORY_ARTIFACT ?? 'artifacts/screen-probe/scene-history-validity';
  mkdirSync(directory, { recursive: true });
  writeFileSync(`${directory}/copy-compiled.wgsl`, copyCompiled.wgsl);
  writeFileSync(`${directory}/trace-compiled.wgsl`, traceCompiled.wgsl);
  writeFileSync(`${directory}/source.wgsl`, source);
  writeFileSync(
    `${directory}/reflection.json`,
    JSON.stringify({ copy: copyCompiled.reflection, trace: traceCompiled.reflection }, null, 2),
  );
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Scene-history RED requires a real GPU adapter');
  const device = await adapter.requestDevice(),
    errors: string[] = [],
    failures: string[] = [],
    controls: unknown[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  let resources: ReturnType<typeof resourcesFor> | undefined,
    scopePopped = false,
    status = 'fail';
  device.pushErrorScope('validation');
  try {
    resources = resourcesFor(device);
    const copy = await kernel(device, 'copySceneHistory', copyCompiled.wgsl, resources.slots);
    const copyDiffuse = await kernel(
      device,
      'copyDiffuseSceneHistory',
      diffuseCopyCompiled.wgsl,
      resources.slots,
    );
    const trace = await kernel(device, 'traceScreenProbes', traceCompiled.wgsl, resources.slots);
    const cases = [
      ...sceneHistoryCases.map((row) => ({ ...row, history: true, steps: 32 })),
      { ...sceneHistoryCases[0], name: 'disabled-history', history: false, steps: 32 },
      { ...sceneHistoryCases[0], name: 'disabled-trace', history: true, steps: 0 },
      {
        ...sceneHistoryCases[0],
        name: 'subtract-specular-history',
        reflectedHalf: [0x3c00, 0x4000, 0x4000, 0x3c00],
        copiedHalf: [0x4200, 0, 0, 0x3c00],
        rgb: [3, 0, 0],
        history: true,
        steps: 32,
      },
      {
        ...sceneHistoryCases[1],
        name: 'clamped-known-black',
        reflectedHalf: [0x3c00, 0x4000, 0x4000, 0x3c00],
        copiedHalf: [0, 0, 0, 0x3c00],
        history: true,
        steps: 32,
      },
      {
        ...sceneHistoryCases[0],
        name: 'invalid-directional-reflection',
        reflectedHalf: [0x7e00, 0x4000, 0x4000, 0x3c00],
        valid: false,
        history: true,
        steps: 32,
      },
    ];
    for (const row of cases) {
      const texture = new Uint16Array(256 * 4);
      for (let i = 0; i < 256; i++) texture.set(row.half, i * 4);
      const input = new Float32Array(64 * 8),
        words = new Uint32Array(input.buffer);
      for (let i = 0; i < 64; i++) words[i * 8 + 3] = 3 << 12;
      input.set([0.6, 0, -0.8]);
      words[3] = (1 << 12) | 512;
      input[7] = -1;
      device.queue.writeTexture(
        { texture: resources.color },
        texture,
        { bytesPerRow: 128 },
        [16, 16],
      );
      const hasReflection = 'reflectedHalf' in row;
      if (hasReflection) {
        const reflected = new Uint16Array(256 * 4);
        for (let i = 0; i < 256; i++) reflected.set(row.reflectedHalf, i * 4);
        device.queue.writeTexture(
          { texture: resources.reflection },
          reflected,
          { bytesPerRow: 128 },
          [16, 16],
        );
      }
      device.queue.writeBuffer(resources.frame, 0, frameData(row.history, row.steps));
      device.queue.writeBuffer(resources.rays, 0, input);
      const encoder = device.createCommandEncoder();
      const copyPass = encoder.beginComputePass();
      const historyCopy = hasReflection ? copyDiffuse : copy;
      copyPass.setPipeline(historyCopy.pipeline);
      copyPass.setBindGroup(0, historyCopy.group);
      copyPass.dispatchWorkgroups(4);
      copyPass.end();
      encoder.copyBufferToBuffer(
        resources.previous,
        0,
        resources.copied,
        0,
        resources.previous.size,
      );
      const tracePass = encoder.beginComputePass();
      tracePass.setPipeline(trace.pipeline);
      tracePass.setBindGroup(0, trace.group);
      tracePass.dispatchWorkgroups(1);
      tracePass.end();
      encoder.copyBufferToBuffer(resources.rays, 0, resources.output, 0, resources.output.size);
      device.queue.submit([encoder.finish()]);
      const history = await mappedBytes(resources.copied),
        rays = await mappedBytes(resources.output);
      const raw = { input: new Uint8Array(texture.buffer), previous: history, rays };
      const artifacts = Object.entries(raw).map(([kind, bytes]) => {
        const path = `${directory}/${row.name}-${kind}.bin`;
        writeFileSync(path, bytes);
        return { kind, path, bytes: bytes.byteLength, sha256: sha(bytes) };
      });
      const assertSceneHistoryObservation = () => {
        const packed = new Uint16Array(history.buffer, history.byteOffset, history.byteLength / 2);
        for (let i = 0; i < 256; i++) {
          if (packed[i * 4 + 3] !== (row.valid ? 0x3c00 : 0)) {
            failures.push(`${row.name}:copied-validity:${i}:${packed[i * 4 + 3]}`);
            break;
          }
        }
        const expectedHalf = 'copiedHalf' in row ? row.copiedHalf : row.half;
        if (row.valid && [0, 1, 2].some((c) => packed[c] !== expectedHalf[c]))
          failures.push(`${row.name}:copied-rgb:${Array.from(packed.slice(0, 3))}`);
        const actual = new Float32Array(rays.buffer, rays.byteOffset, rays.byteLength / 4);
        const flags = new Uint32Array(rays.buffer, rays.byteOffset, rays.byteLength / 4);
        const expectedStatus = row.valid && row.history && row.steps > 0 ? 0 : 1;
        const observedStatus = ((flags[3] ?? 0) >>> 12) & 7;
        if (observedStatus !== expectedStatus)
          failures.push(`${row.name}:ray-status:${observedStatus}:expected:${expectedStatus}`);
        const unchanged = Buffer.from(rays.subarray(0, 32)).equals(
          Buffer.from(input.buffer, 0, 32),
        );
        if (expectedStatus === 1 && !unchanged)
          failures.push(`${row.name}:original-world-ray-changed`);
        if (expectedStatus === 0 && [0, 1, 2].some((c) => actual[4 + c] !== row.rgb[c]))
          failures.push(`${row.name}:resolved-rgb:${Array.from(actual.slice(4, 7))}`);
        controls.push({
          name: row.name,
          inputHalf: row.half,
          valid: row.valid,
          history: row.history,
          steps: row.steps,
          expectedStatus,
          observedStatus,
          copiedFirstPixel: Array.from(packed.slice(0, 4)),
          firstRayWords: Array.from(flags.slice(0, 8)),
          originalWorldRayUnchanged: unchanged,
          artifacts,
        });
      };
      assertSceneHistoryObservation();
    }
    const validation = await device.popErrorScope();
    scopePopped = true;
    if (validation) errors.push(validation.message);
    expect(errors).toEqual([]);
    expect(failures).toEqual([]);
    status = 'pass';
  } finally {
    if (!scopePopped) {
      const validation = await device.popErrorScope();
      if (validation) errors.push(validation.message);
    }
    resources?.dispose();
    device.destroy();
    writeFileSync(
      `${directory}/result.json`,
      JSON.stringify(
        {
          status,
          adapterInfo: adapter.info,
          backend: process.env.FORGEAX_WEBGPU_NODE ?? 'dawn',
          sourceSha256: sha(source),
          compiledSha256: { copy: sha(copyCompiled.wgsl), trace: sha(traceCompiled.wgsl) },
          controls,
          errors,
          failures,
          scope:
            'Actual rgba16float copySceneHistory -> same-buffer previousRadiance -> actual traceScreenProbes on the existing 16x16 forward plane. No World dispatch, P0 attribution, full-scene, physical correctness or performance qualification.',
        },
        null,
        2,
      ),
    );
  }
});
