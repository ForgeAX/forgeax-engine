import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import {
  assessSceneCandidates,
  sceneCandidateCases,
  sceneCandidateInput,
  sceneCandidateKernel,
} from './sdf-scene-candidates.fixture';

let device: GPUDevice;
let cases: Awaited<ReturnType<typeof sceneCandidateCases>>;
const compiled = new Map<string, string>();
const errors: string[] = [];
beforeAll(async () => {
  cases = await sceneCandidateCases();
  for (const variant of ['original', 'skip-raw-admission'] as const)
    compiled.set(
      variant,
      (
        await compileShader(sceneCandidateKernel(variant), {
          id: `scene-candidate-admission-${variant}`,
        })
      ).unwrap().wgsl,
    );
  const expectedKernels = process.env.FORGEAX_SCENE_CANDIDATE_KERNEL_SHA256;
  if (expectedKernels) {
    const expected: unknown = JSON.parse(expectedKernels);
    const actual = [...compiled.values()].map((source) =>
      createHash('sha256').update(source).digest('hex'),
    );
    expect(expected).toEqual(actual);
  }
  const expectedInput = process.env.FORGEAX_SCENE_CANDIDATE_INPUT_SHA256;
  if (expectedInput)
    expect(createHash('sha256').update(sceneCandidateInput(cases)).digest('hex')).toBe(
      expectedInput,
    );
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw Error('Actual Dawn adapter required');
  // The bounded hardware diagnostic separately gates these actual getters
  // before requestDevice. Ordinary CI may use its maintained software adapter.
  const info = adapter.info;
  console.log(
    JSON.stringify({
      phase: 'candidate-adapter-before-device',
      vendor: info.vendor,
      architecture: info.architecture,
      device: info.device,
      description: info.description,
    }),
  );
  const out = process.env.FORGEAX_SCENE_CANDIDATE_EVIDENCE;
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(
      `${out}/adapter-before-device.json`,
      JSON.stringify(
        {
          vendor: info.vendor,
          architecture: info.architecture,
          device: info.device,
          description: info.description,
        },
        null,
        2,
      ),
    );
  }
  device = await adapter.requestDevice();
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
}, 10_000);
afterAll(() => device?.destroy(), 10_000);

async function run(code: string, variant: string) {
  const bytes = sceneCandidateInput(cases);
  const input = device.createBuffer({ size: bytes.byteLength, usage: 128 | 8 });
  const output = device.createBuffer({ size: cases.length * 32, usage: 128 | 4 });
  const staging = device.createBuffer({ size: output.size, usage: 1 | 8 });
  try {
    device.queue.writeBuffer(input, 0, bytes);
    console.error(`[candidate-phase] ${variant} module.begin`);
    const module = device.createShaderModule({ code });
    console.error(`[candidate-phase] ${variant} pipeline.begin`);
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'candidateTest' },
    });
    console.error(`[candidate-phase] ${variant} pipeline.end`);
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: input } },
        { binding: 1, resource: { buffer: output } },
      ],
    });
    const encoder = device.createCommandEncoder(),
      pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(cases.length);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, staging, 0, output.size);
    device.queue.submit([encoder.finish()]);
    console.error(`[candidate-phase] ${variant} readback.begin`);
    await staging.mapAsync(1);
    const result = new Uint32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    console.error(`[candidate-phase] ${variant} readback.end`);
    return result;
  } finally {
    input.destroy();
    output.destroy();
    staging.destroy();
  }
}
for (const variant of ['original', 'skip-raw-admission'] as const)
  it(`preserves complete V3 candidate admission: ${variant}`, async () => {
    const source = compiled.get(variant);
    if (!source) throw Error('Validated actual kernel required');
    const actual = await run(source, variant),
      failures = assessSceneCandidates(cases, actual);
    const out = process.env.FORGEAX_SCENE_CANDIDATE_EVIDENCE;
    if (out) {
      mkdirSync(out, { recursive: true });
      writeFileSync(`${out}/${variant}.u32`, new Uint8Array(actual.buffer));
      writeFileSync(
        `${out}/${variant}.json`,
        JSON.stringify(
          {
            scope: 'Candidates/admission observations only; not World trace or GI results',
            candidateStateMeaning: { 0: 'indexed', 1: 'full-roster', 2: 'unknown' },
            variant,
            cases: cases.length,
            compiledSHA256: createHash('sha256').update(source).digest('hex'),
            failures,
            errors,
            actual: [...actual],
          },
          null,
          2,
        ),
      );
    }
    expect(errors).toEqual([]);
    if (variant === 'original') expect(failures).toEqual([]);
    else expect(failures).toContain('selected-invalid-before-cull');
  }, 30_000);
