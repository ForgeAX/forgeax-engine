import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import {
  assessEndpointAggregation,
  assessEndpointComposition,
  endpointCompositionSource,
  endpointRowCompositionCode,
  endpointRowCompositionInput,
  endpointSceneCompositionCode,
  endpointSceneCompositionInput,
  prepareEndpointAggregation,
  prepareEndpointComposition,
  requireEndpointPhysicalAdapter,
  runEndpointAggregation,
} from './sdf-surface-endpoint-aggregation.fixture';
import { runSurfaceBufferWork } from './sdf-surface-intersection.fixture';

function endpointStage(stage: string, detail?: object) {
  const line = JSON.stringify({ stage, detail, pid: process.pid, at: new Date().toISOString() });
  console.log(`[endpoint-phase] ${line}`);
  const directory = process.env.FORGEAX_SURFACE_ENDPOINT_OUTPUT;
  if (directory !== undefined) {
    mkdirSync(directory, { recursive: true });
    appendFileSync(join(directory, 'phases.jsonl'), `${line}\n`);
  }
}

it('preserves real primitive endpoint uncertainty through actual Row and Scene traversal', async () => {
  endpointStage('prepare.begin');
  const prepared = await prepareEndpointAggregation();
  endpointStage('prepare.end');
  endpointStage('naga.begin');
  const compiled = (
    await compileShader(prepared.code, { id: 'sdf-surface-endpoint-aggregation' })
  ).unwrap();
  endpointStage('naga.end');
  const directory = process.env.FORGEAX_SURFACE_ENDPOINT_OUTPUT ?? 'artifacts/sdf-surface-endpoint';
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'input.bin'), prepared.input);
  writeFileSync(join(directory, 'actual.wgsl'), compiled.wgsl);
  endpointStage('adapter.begin');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('Endpoint aggregation requires an actual GPU adapter');
  const info = adapter.info;
  const adapterReceipt = {
    vendor: info.vendor,
    architecture: info.architecture,
    device: info.device,
    description: info.description,
  };
  endpointStage('adapter.end', adapterReceipt);
  if (process.env.FORGEAX_SURFACE_ENDPOINT_REQUIRE_RTX4080 === '1')
    requireEndpointPhysicalAdapter(adapterReceipt);
  endpointStage('device.begin');
  const device = await adapter.requestDevice(),
    errors: string[] = [];
  endpointStage('device.end');
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  let assessment: ReturnType<typeof assessEndpointAggregation> | undefined;
  try {
    endpointStage('runSurfaceBufferWork.begin');
    const raw = await runEndpointAggregation(device, compiled.wgsl, prepared);
    endpointStage('runSurfaceBufferWork.end');
    writeFileSync(
      join(directory, 'stages.bin'),
      new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength),
    );
    assessment = assessEndpointAggregation(prepared.cases, raw);
    expect(
      assessment.endpointWitness,
      'Actual primitive must expose the closed-end uncertain witness',
    ).toBe(true);
    expect(assessment.failures).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    device.destroy();
    endpointStage('device.destroyed');
    writeFileSync(
      join(directory, 'result.json'),
      JSON.stringify(
        {
          cases: prepared.cases,
          assessment,
          adapter: adapterReceipt,
          errors,
          scope:
            'Primitive/Row/Scene endpoint aggregation component only; not Native, full World, scene GI or performance qualification',
        },
        null,
        2,
      ),
    );
  }
}, 30_000);

it('preserves real GPU endpoint uncertainty through extracted aggregation components', async () => {
  endpointStage('composition.prepare.begin');
  const prepared = prepareEndpointComposition(endpointCompositionSource());
  const directory = process.env.FORGEAX_SURFACE_ENDPOINT_OUTPUT ?? 'artifacts/sdf-surface-endpoint';
  mkdirSync(directory, { recursive: true });
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('Endpoint composition requires an actual GPU adapter');
  const info = adapter.info;
  const actual = {
    vendor: info.vendor,
    architecture: info.architecture,
    device: info.device,
    description: info.description,
  };
  endpointStage('composition.adapter', actual);
  if (process.env.FORGEAX_SURFACE_ENDPOINT_REQUIRE_RTX4080 === '1')
    requireEndpointPhysicalAdapter(actual);
  const device = await adapter.requestDevice(),
    errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  let assessment: ReturnType<typeof assessEndpointComposition> | undefined;
  try {
    const primitiveCode = (
      await compileShader(prepared.primitiveCode, { id: 'endpoint-composition-primitive' })
    ).unwrap().wgsl;
    writeFileSync(join(directory, 'primitive-input.bin'), prepared.primitiveInput);
    writeFileSync(join(directory, 'primitive.wgsl'), primitiveCode);
    endpointStage('composition.primitive.begin');
    const primitive = await runSurfaceBufferWork(
      device,
      primitiveCode,
      prepared.primitiveInput,
      'surfaceTest',
      prepared.primitives.length,
      32,
    );
    writeFileSync(
      join(directory, 'primitive.bin'),
      new Uint8Array(primitive.buffer, primitive.byteOffset, primitive.byteLength),
    );
    endpointStage('composition.primitive.end');
    expect(primitive[0], 'Actual endpoint primitive must be uncertain').toBe(2);
    expect(new Float32Array(primitive.buffer, primitive.byteOffset, primitive.length)[1]).toBe(1);
    const rowInput = endpointRowCompositionInput(prepared.rows, primitive);
    const rowCode = (
      await compileShader(endpointRowCompositionCode(prepared.parts), {
        id: 'endpoint-composition-row',
      })
    ).unwrap().wgsl;
    writeFileSync(join(directory, 'row-input.bin'), rowInput);
    writeFileSync(join(directory, 'row.wgsl'), rowCode);
    endpointStage('composition.row.begin');
    const rows = await runSurfaceBufferWork(
      device,
      rowCode,
      rowInput,
      'endpointRows',
      prepared.rows.length,
      prepared.parts.members.length * 4,
    );
    writeFileSync(
      join(directory, 'row.bin'),
      new Uint8Array(rows.buffer, rows.byteOffset, rows.byteLength),
    );
    endpointStage('composition.row.end');
    const sceneInput = endpointSceneCompositionInput(prepared, rows);
    const sceneCode = (
      await compileShader(endpointSceneCompositionCode(prepared.parts), {
        id: 'endpoint-composition-scene',
      })
    ).unwrap().wgsl;
    writeFileSync(join(directory, 'scene-input.bin'), sceneInput);
    writeFileSync(join(directory, 'scene.wgsl'), sceneCode);
    endpointStage('composition.scene.begin');
    const scenes = await runSurfaceBufferWork(
      device,
      sceneCode,
      sceneInput,
      'endpointScenes',
      prepared.cases.length,
      prepared.parts.members.length * 4,
    );
    writeFileSync(
      join(directory, 'scene.bin'),
      new Uint8Array(scenes.buffer, scenes.byteOffset, scenes.byteLength),
    );
    endpointStage('composition.scene.end');
    assessment = assessEndpointComposition(prepared, primitive, rows, scenes);
    expect(assessment.failures).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    device.destroy();
    writeFileSync(
      join(directory, 'composition-result.json'),
      JSON.stringify(
        {
          cases: prepared.cases,
          rows: prepared.rows,
          actual,
          members: prepared.parts.members,
          assessment,
          errors,
          scope:
            'Actual primitive GPU to extracted aggregation components only; not full BVH traversal, canonical admission, Native, GI or performance qualification',
        },
        null,
        2,
      ),
    );
  }
}, 30_000);
