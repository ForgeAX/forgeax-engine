#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const fixturePath = resolve(repoRoot, 'apps/hello/format-tier1/fixtures/meshopt-triangle.gltf');
const referencePath = resolve(repoRoot, 'apps/hello/format-tier1/fixtures/meshopt-triangle-reference.json');
const evidencePath = resolve(repoRoot, 'artifacts/format-tier1/meshopt-gpu-evidence.json');
const featureId = 'feat-20260812-format-classification-tier1';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function structuredError(error, expected, hint) {
  return {
    code: error?.code ?? 'format-tier1-meshopt-refusal',
    expected,
    hint,
    detail: JSON.stringify(error?.detail ?? error),
  };
}

function copyBytes(value) {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function alignedSize(size) {
  return (size + 3) & ~3;
}

function maxAbsError(actual, expected) {
  if (actual.length !== expected.length) return Number.POSITIVE_INFINITY;
  let max = 0;
  for (let index = 0; index < actual.length; index += 1) {
    max = Math.max(max, Math.abs((actual[index] ?? 0) - (expected[index] ?? 0)));
  }
  return max;
}

function referenceComparison(actual, expected) {
  const error = maxAbsError(actual, expected);
  return {
    status: Number.isFinite(error) && error <= 0.000001 ? 'pass' : 'error',
    maxAbsError: error,
    threshold: 0.000001,
    actualLength: actual.length,
    referenceLength: expected.length,
  };
}

async function readbackBuffer(device, source, label) {
  const bytes = copyBytes(source);
  const padded = new Uint8Array(alignedSize(bytes.byteLength));
  padded.set(bytes);
  const gpuSource = device.createBuffer({
    label: `${label}-source`,
    size: padded.byteLength,
    usage: 0x20 | 0x04 | 0x08,
  });
  device.queue.writeBuffer(gpuSource, 0, padded);
  const readback = device.createBuffer({
    label: `${label}-readback`,
    size: alignedSize(bytes.byteLength),
    usage: 0x01 | 0x08,
  });
  const encoder = device.createCommandEncoder({ label: `${label}-copy` });
  encoder.copyBufferToBuffer(gpuSource, 0, readback, 0, alignedSize(bytes.byteLength));
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  await readback.mapAsync(0x01);
  const actual = new Uint8Array(readback.getMappedRange()).slice(0, bytes.byteLength);
  readback.unmap();
  gpuSource.destroy();
  readback.destroy();
  return actual;
}

const fixtureBytes = await readFile(fixturePath);
const fixture = JSON.parse(fixtureBytes.toString('utf8'));
const referenceBytes = await readFile(referencePath);
const reference = JSON.parse(referenceBytes.toString('utf8'));
const { meshoptDecoder } = await import('@forgeax/engine-gltf/importer');
const { meshIrToMeshAsset, parseGltf } = await import('@forgeax/engine-gltf');

async function parseFixture(value, source) {
  return parseGltf(
    value,
    async (uri) => {
      throw new Error(`Meshopt fixture unexpectedly requested external buffer ${uri}`);
    },
    source,
    { meshopt: meshoptDecoder },
  );
}

const parsed = await parseFixture(fixture, fixturePath);
if (!parsed.ok) throw new Error(`Meshopt fixture failed before Dawn: ${parsed.error.code}`);
const primitive = parsed.value.meshes[0];
if (primitive === undefined || primitive.indices === undefined) {
  throw new Error('Meshopt fixture did not produce a positioned indexed primitive');
}
const meshResult = meshIrToMeshAsset([primitive]);
if (!meshResult.ok) throw meshResult.error;
const mesh = meshResult.value;
const damagedFixture = structuredClone(fixture);
const damagedExtension = damagedFixture.bufferViews[4].extensions.EXT_meshopt_compression;
damagedExtension.byteLength += 1;
const damaged = await parseFixture(damagedFixture, `${fixturePath}#damaged`);
const malformed = damaged.ok
  ? {
      status: 'unexpected-success',
      error: structuredError(
        { code: 'format-tier1-meshopt-malformed-accepted' },
        'damaged EXT_meshopt_compression input is rejected',
        'keep the malformed fixture refusal fail-closed',
      ),
    }
  : {
      status: 'refused',
      error: structuredError(
        damaged.error,
        'damaged EXT_meshopt_compression input is rejected',
        'repair the compressed artifact or inspect the decoder detail',
      ),
    };

const { create, globals } = await import('@forgeax/engine-dawn-node');
Object.assign(globalThis, globals);
const gpu = create([]);
const adapter = await gpu.requestAdapter();
if (adapter === null) {
  const report = {
    schemaVersion: 'format-tier1-meshopt-gpu/1',
    featureId,
    generatedAt: new Date().toISOString(),
    sourceCodeSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
    fixture: { path: 'apps/hello/format-tier1/fixtures/meshopt-triangle.gltf', sha256: sha256(fixtureBytes) },
    reference: { path: 'apps/hello/format-tier1/fixtures/meshopt-triangle-reference.json', sha256: sha256(referenceBytes) },
    status: 'blocked',
    capabilityRefusal: {
      code: 'dawn-adapter-unavailable',
      expected: 'Dawn provides a GPU adapter for the reference buffer readback',
      hint: 'rerun on a worker with Dawn/WebGPU available',
      detail: 'navigator.gpu.requestAdapter() returned null',
    },
    decoded: {
      topology: mesh.submeshes[0]?.topology ?? 'triangle-list',
      attributes: Object.keys(mesh.attributes),
      vertexCount: primitive.positions.length / 3,
      indexCount: primitive.indices.length,
    },
    malformed,
  };
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report));
  process.exitCode = 2;
} else {
  const device = await adapter.requestDevice();
  const actualPositions = await readbackBuffer(device, primitive.positions, 'meshopt-positions');
  const actualNormals = await readbackBuffer(device, primitive.normals, 'meshopt-normals');
  const actualUvs = await readbackBuffer(device, primitive.texcoord0, 'meshopt-uv');
  const actualTangents = await readbackBuffer(device, primitive.tangents, 'meshopt-tangent');
  const actualIndices = await readbackBuffer(device, primitive.indices, 'meshopt-indices');
  const positionReadback = referenceComparison(new Float32Array(actualPositions.buffer), reference.attributes.position);
  const normalReadback = referenceComparison(new Float32Array(actualNormals.buffer), reference.attributes.normal);
  const uvReadback = referenceComparison(new Float32Array(actualUvs.buffer), reference.attributes.uv);
  const tangentReadback = referenceComparison(new Float32Array(actualTangents.buffer), reference.attributes.tangent);
  const indexReadback = referenceComparison(new Uint16Array(actualIndices.buffer), reference.indices);
  assert.equal(positionReadback.status, 'pass');
  assert.equal(normalReadback.status, 'pass');
  assert.equal(uvReadback.status, 'pass');
  assert.equal(tangentReadback.status, 'pass');
  assert.equal(indexReadback.status, 'pass');
  const report = {
    schemaVersion: 'format-tier1-meshopt-gpu/1',
    featureId,
    generatedAt: new Date().toISOString(),
    sourceCodeSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
    fixture: { path: 'apps/hello/format-tier1/fixtures/meshopt-triangle.gltf', sha256: sha256(fixtureBytes) },
    reference: { path: 'apps/hello/format-tier1/fixtures/meshopt-triangle-reference.json', sha256: sha256(referenceBytes) },
    status: 'pass',
    consumer: 'Dawn reference buffer upload and MAP_READ readback',
    decoded: {
      topology: mesh.submeshes[0]?.topology ?? 'triangle-list',
      attributes: Object.keys(mesh.attributes),
      vertexCount: primitive.positions.length / 3,
      indexCount: primitive.indices.length,
      attributeReadback: {
        position: positionReadback,
        normal: normalReadback,
        uv: uvReadback,
        tangent: tangentReadback,
      },
      indexReadback,
    },
    malformed,
  };
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report));
}
