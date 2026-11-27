import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SDF_SURFACE_POOL_LAYOUT as publishedLayout } from '@forgeax/engine-shader';
import { expect, it } from 'vitest';
import { SDF_SURFACE_POOL_LAYOUT as sourceLayout } from '../../../../shader/src/sdf-surface-pool-wgsl';
import { compileShader } from '../../../../shader-compiler/src/index';
import {
  endpointAggregationKernel,
  endpointCases,
  endpointCompositionSource,
  endpointOracle,
  endpointOwningFunctions,
  endpointRowCompositionCode,
  endpointRowCompositionInput,
  endpointSceneCompositionCode,
  endpointSceneCompositionInput,
  prepareEndpointAggregation,
  prepareEndpointComposition,
  requireEndpointPhysicalAdapter,
} from './sdf-surface-endpoint-aggregation.fixture';

it('independently proves the f32 endpoint edge and all authored nearest/miss controls', () => {
  const cases = endpointCases();
  expect(cases).toHaveLength(10);
  for (const row of cases) {
    const hits = endpointOracle(row),
      first = hits[0];
    if (row.nearest === null) expect(hits, row.name).toEqual([]);
    else {
      expect(first, row.name).toBeDefined();
      if (!first) throw new Error('Required exact authored hit missing');
      expect(Number(first.time) / Number(first.det), row.name).toBe(row.nearest);
    }
  }
  const firstCase = cases[0];
  if (!firstCase) throw new Error('Required endpoint witness missing');
  const first = endpointOracle(firstCase)[0];
  if (!first) throw new Error('Required exact endpoint hit missing');
  expect(first.u + first.v).toBe(first.det);
  expect(first.time).toBe(first.det);
  expect(new Uint32Array(Float32Array.of(firstCase.origin[0]).buffer)[0]).toBe(0x3dcccccd);
});

it('uses exact owning Row/Scene source and only canonical public builder/packer input', async () => {
  expect(publishedLayout).toEqual(sourceLayout);
  const prepared = await prepareEndpointAggregation();
  expect(prepared.cases).toHaveLength(10);
  expect(prepared.input.byteLength).toBeGreaterThan(10 * 16 * 4);
  for (const source of endpointOwningFunctions) expect(endpointAggregationKernel).toContain(source);
  const result = await compileShader(prepared.code, { id: 'sdf-surface-endpoint-aggregation' });
  expect(result.ok, result.ok ? undefined : result.error.message).toBe(true);
  const directory = process.env.FORGEAX_SURFACE_ENDPOINT_PREPARE_OUTPUT;
  if (directory !== undefined && result.ok) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'input.bin'), prepared.input);
    writeFileSync(join(directory, 'kernel.wgsl'), prepared.code);
    writeFileSync(join(directory, 'compiled.wgsl'), result.value.wgsl);
    writeFileSync(join(directory, 'cases.json'), JSON.stringify(prepared.cases, null, 2));
    const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    writeFileSync(
      join(directory, 'prepared.json'),
      JSON.stringify(
        {
          cases: prepared.cases.length,
          variants: 1,
          inputBytes: prepared.input.byteLength,
          outputBytes: prepared.cases.length * 64,
          inputSha256: hash(prepared.input),
          sourceSha256: hash(prepared.code),
          compiledSha256: hash(result.value.wgsl),
          deviceCreated: false,
        },
        null,
        2,
      ),
    );
  }
}, 30_000);

it('requires the recorded physical adapter getter tuple before device creation', () => {
  const actual = process.env.FORGEAX_ENDPOINT_ACTUAL_ADAPTER
    ? JSON.parse(process.env.FORGEAX_ENDPOINT_ACTUAL_ADAPTER)
    : {
        vendor: 'nvidia',
        architecture: 'lovelace',
        device: 'nvidia-geforce-rtx-4080',
        description: 'D3D12 driver version 32.0.16.1742',
      };
  expect(() => requireEndpointPhysicalAdapter(actual)).not.toThrow();
  for (const wrong of [
    { ...actual, vendor: 'intel', architecture: 'gen-12lp', device: 'intel-uhd-graphics-770' },
    { ...actual, device: 'nvidia-geforce-rtx-4080-super' },
    { ...actual, description: 'D3D12 driver version 0.0.0.0' },
    ...(['vendor', 'architecture', 'device', 'description'] as const).map((key) => ({
      ...actual,
      [key]: undefined,
    })),
  ])
    expect(() => requireEndpointPhysicalAdapter(wrong)).toThrow();
  if (process.env.FORGEAX_ENDPOINT_OLD_KERNEL_SHA256)
    expect(createHash('sha256').update(endpointAggregationKernel).digest('hex')).toBe(
      process.env.FORGEAX_ENDPOINT_OLD_KERNEL_SHA256,
    );
});

it('maps original endpoint geometry and opaque GPU tuples into exact source aggregation components', async () => {
  const prepared = prepareEndpointComposition(endpointCompositionSource());
  expect(prepared.cases).toHaveLength(10);
  expect(prepared.primitives).toHaveLength(16);
  expect(prepared.rows).toHaveLength(13);
  expect([9, 10]).toContain(prepared.parts.members.length);
  for (const [i, row] of prepared.rows.entries()) {
    expect(row.first).toBe(prepared.rows.slice(0, i).reduce((sum, value) => sum + value.count, 0));
    expect(row.count).toBe(prepared.cases[row.caseIndex]?.meshes[row.row]?.length);
  }
  // These arbitrary words test only lossless framing; they are never asserted
  // to be primitive outcomes or uploaded by the GPU correctness test.
  const opaquePrimitive = Uint32Array.from({ length: 16 * 8 }, (_, i) => (0x80000000 + i) >>> 0);
  const rowInput = endpointRowCompositionInput(prepared.rows, opaquePrimitive);
  expect(
    new Uint32Array(rowInput.buffer).slice(4 + 13 * 12, 4 + 13 * 12 + opaquePrimitive.length),
  ).toEqual(opaquePrimitive);
  const opaqueRows = Uint32Array.from(
    { length: 13 * prepared.parts.members.length },
    (_, i) => (0xf0000000 + i) >>> 0,
  );
  const sceneInput = endpointSceneCompositionInput(prepared, opaqueRows);
  expect(new Uint32Array(sceneInput.buffer).slice(4 + 10 * 16)).toEqual(opaqueRows);
  const rowCode = endpointRowCompositionCode(prepared.parts),
    sceneCode = endpointSceneCompositionCode(prepared.parts);
  expect(rowCode).toContain(prepared.parts.accept);
  expect(rowCode).toContain(prepared.parts.tail);
  expect(sceneCode).toContain(prepared.parts.scene);
  const programs = { primitive: prepared.primitiveCode, row: rowCode, scene: sceneCode };
  for (const [name, code] of Object.entries(programs)) {
    const compiled = await compileShader(code, { id: `endpoint-composition-${name}` });
    expect(compiled.ok, compiled.ok ? undefined : compiled.error.message).toBe(true);
    const directory = process.env.FORGEAX_SURFACE_ENDPOINT_PREPARE_OUTPUT;
    if (directory !== undefined && compiled.ok) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, `${name}.source.wgsl`), code);
      writeFileSync(join(directory, `${name}.compiled.wgsl`), compiled.value.wgsl);
      writeFileSync(
        join(directory, 'composition-map.json'),
        JSON.stringify(
          {
            cases: prepared.cases,
            primitives: prepared.primitives,
            rows: prepared.rows,
            members: prepared.parts.members,
          },
          null,
          2,
        ),
      );
    }
  }
}, 30_000);
