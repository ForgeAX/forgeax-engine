import { expect, it } from 'vitest';
import { createProbeGlobalMesh } from '../../../render/src/__tests__/raytracing/probe-global.fixture';
import { packGlobalSdfComposition } from '../../../render/src/raytracing/global-sdf';
import {
  IRRADIANCE_FIELD_COVERAGE_WGSL,
  packIrradianceFieldFrame,
} from '../../../render/src/raytracing/irradiance-field';
import { compileShader } from '../../../shader-compiler/src/index';
import { loadEngineShaderEntries } from '../../../vite-plugin-shader/src/engine-inputs/load-engine-shader-entries';
import { coverageBindings, coverageSoftwareFrame } from './renderer-gi-coverage-bindings.fixture';

async function acceptedSoftwareSource() {
  const mesh = await createProbeGlobalMesh(1, 1, 1);
  if (!mesh.distanceField) throw Error('Actual visibility field required');
  const source = packGlobalSdfComposition(
    [
      {
        instanceId: 1,
        geometryId: 1,
        mask: 255,
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        field: mesh.distanceField,
        surfaceCoverage: 'opaque',
      },
    ],
    {
      origin: [-2, -2, -2],
      dimensions: [9, 9, 9],
      spacing: 0.5,
      maxDistance: 4,
      coverageDistance: 0.5,
    },
    { sourceEpoch: 7 },
  ).unwrap();
  if (!source.sourceExpected) throw Error('Actual source publication required');
  const visibility = new Uint8Array(64);
  new Uint32Array(visibility.buffer).set(source.sourceExpected, 12);
  const frame = packIrradianceFieldFrame({
    worldSource: { traversal: 'ray-query' },
    probeBudget: 32,
    raysPerProbe: 64,
    frameIndex: 7,
    tileOffset: 3,
    tileBudget: 5,
    tileCount: 12,
    lightCount: 2,
    atlasWidth: 128,
    cardResolution: 16,
    radiosity: true,
    environment: [0.25, 0.5, 0.75],
    hysteresis: 0.9,
    maxDistance: 100,
    surfaceBias: 0.05,
    depthClamp: 2,
    cardMargin: 0.125,
    gather: [64, 32, 32, 16],
    query: new Uint8Array(new Uint32Array([64, 0x3f800000]).buffer),
    reflections: [12, 0.25],
  });
  return { source, visibility, frame };
}

it('uses the accepted visibility source only for the independent software diagnostic Frame', async () => {
  const { source, visibility, frame } = await acceptedSoftwareSource();
  const before = frame.slice();
  expect(Array.from(new Uint32Array(frame.buffer, 112))).toEqual([0, 0, 0, 0]);
  const diagnostic = coverageSoftwareFrame(
    frame,
    visibility,
    source.data.settings,
    source.data.instances.byteLength,
    source.data.fields.byteLength,
  );
  expect(diagnostic.slice(0, 112)).toEqual(frame.slice(0, 112));
  expect(Array.from(new Uint32Array(diagnostic.buffer, 112))).toEqual(source.sourceExpected);
  expect(frame).toEqual(before);
});

it('rejects zero or stale visibility tuples and mismatched source spans instead of qualifying them', async () => {
  const { source, visibility, frame } = await acceptedSoftwareSource();
  const check = (packet: Uint8Array, bytes = source.data.fields.byteLength) =>
    coverageSoftwareFrame(
      frame,
      packet,
      source.data.settings,
      source.data.instances.byteLength,
      bytes,
    );
  expect(() => check(new Uint8Array(64))).toThrow();
  const stale = visibility.slice();
  new Uint32Array(stale.buffer)[15] = 6;
  expect(() => check(stale)).toThrow('does not match');
  expect(() => check(visibility, source.data.fields.byteLength + 4)).toThrow('does not match');
  expect(() => check(visibility.subarray(0, 48))).toThrow('complete current Frame');
});

it('binds exactly the resources reachable from the actual coverage entry', async () => {
  const compiled = await compileShader(IRRADIANCE_FIELD_COVERAGE_WGSL, {
    computeEntry: 'classifyRays',
    imports: (await loadEngineShaderEntries()).imports,
  });
  expect(compiled.ok, compiled.ok ? undefined : compiled.error.message).toBe(true);
  if (!compiled.ok) return;
  const active = compiled.value.manifestEntry.entryPoints?.find(
    (entry) => entry.name === 'classifyRays',
  )?.bindings;
  expect(active).toBeDefined();
  const supplied = [
    7,
    8,
    ...(await coverageBindings(IRRADIANCE_FIELD_COVERAGE_WGSL)).map(([binding]) => binding),
  ].sort((a, b) => a - b);
  expect(supplied).toEqual(active?.map(({ binding }) => binding).sort((a, b) => a - b));
});

it('restores the voxel binding when the actual entry consumes it again', async () => {
  const source = IRRADIANCE_FIELD_COVERAGE_WGSL.replace(
    'coverage[i]=out;',
    'out.metrics.x+=voxels[0].distance;coverage[i]=out;',
  );
  expect(source).not.toBe(IRRADIANCE_FIELD_COVERAGE_WGSL);
  expect((await coverageBindings(source)).map(([binding]) => binding)).toContain(0);
});

it('rejects an active binding without a captured resource label', async () => {
  const source = `${IRRADIANCE_FIELD_COVERAGE_WGSL.replace(
    'coverage[i]=out;',
    'out.metrics.x+=extra[0];coverage[i]=out;',
  )}\n@group(0) @binding(16) var<storage,read> extra: array<f32>;`;
  await expect(coverageBindings(source)).rejects.toThrow('Unknown coverage resource 0:16');
});

it('rejects loss of either diagnostic caller binding', async () => {
  const noOutput = IRRADIANCE_FIELD_COVERAGE_WGSL.replace('coverage[i]=out;', '').replace(
    'i>=arrayLength(&coverage)||',
    '',
  );
  await expect(coverageBindings(noOutput)).rejects.toThrow('Coverage caller binding 8 is missing');
  const noRays = IRRADIANCE_FIELD_COVERAGE_WGSL.replace(
    'let ray=coverageRays[i];',
    'let ray=Ray(vec3f(0),0.0,vec3f(0,0,-1),8.0,vec4u(1u,0u,0u,0u));',
  ).replace('||i>=arrayLength(&coverageRays)', '');
  await expect(coverageBindings(noRays)).rejects.toThrow('Coverage caller binding 7 is missing');
});
