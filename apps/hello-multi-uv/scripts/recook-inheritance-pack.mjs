#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createMaterialArtifactDigest,
  createMaterialCookIdentity,
  createMaterialProgramSetDigest,
} from '@forgeax/engine-pack';
import { derive } from '@forgeax/engine-types';
import { readShaderManifestPublication } from '@forgeax/engine-shader';

const APP_ROOT = resolve(new URL('..', import.meta.url).pathname);
const FIXTURE_PATH = resolve(APP_ROOT, 'src/multi-uv-inheritance.pack.json');
const MANIFEST_PATH = resolve(APP_ROOT, 'dist/shaders/manifest.json');
const MODULE_ID = 'hello-multi-uv::multi-uv-demo';
const ROOT_GUID = '71935b00-7d8c-4c4e-8f12-345678abcd02';
const DERIVED_GUID = '71935b00-7d8c-4c4e-8f12-345678abcd03';
const SOURCE_CLOSURE = ['multi-uv-demo.wgsl'];
const PROGRAM_CONTEXT = {
  backend: 'webgpu',
  capability: 'storage-buffer',
  pipeline: 'forward',
  geometry: 'mesh',
  pass: 'forward',
  profile: 'forgeax-material-wgsl-v1',
  toolchain: 'naga-oil',
  instrumentation: 'none',
};
const writeFixture = process.argv.includes('--write');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function jsonWithBytes(value) {
  const pretty = JSON.stringify(
    value,
    (_key, entry) => (entry instanceof Uint8Array ? [...entry] : entry),
    2,
  );
  return pretty.replace(
    /\[\n((?:\s*(?:"(?:\\.|[^"\\n])*"|[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|true|false|null),?\n)+)\s*\]/g,
    (match, body) => {
      const lines = body
        .split('\n')
        .map((line) => line.trim().replace(/,$/, ''))
        .filter(Boolean);
      return lines.length < 20 ? match : `[${lines.join(',')}]`;
    },
  );
}

function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const manifest = await readShaderManifestPublication(
  JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')),
);
const shader = (manifest.materialShaders ?? []).find((entry) => entry.identifier === MODULE_ID);
assert(shader !== undefined, `shader producer did not emit ${MODULE_ID}`);
assert(Array.isArray(shader.variants) && shader.variants.length > 0, 'shader producer emitted no variants');
const variant = shader.variants.find(
  (entry) => entry.defines?.STORAGE_BUFFER_AVAILABLE === true,
);
assert(variant !== undefined, 'shader producer emitted no default multi-UV variant');

const artifactBytes = new TextEncoder().encode(variant.composedWgsl);
assert(artifactBytes.byteLength > 0, 'shader producer emitted an empty program');
const artifactDigest = createMaterialArtifactDigest(artifactBytes);
const layoutIdentity = derive(JSON.parse(shader.paramSchema)).layoutIdentity;
const parameters = [
  { name: 'baseColor', type: 'color' },
  { name: 'baseColorUvTransform', type: 'vec4' },
  { name: 'baseColorTexture', type: 'texture' },
  { name: 'detailTexture', type: 'texture' },
];
const passes = [{
  name: 'Forward',
  program: { module: MODULE_ID, vertexEntry: 'vs_main', fragmentEntry: 'fs_main' },
  renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
}];
const rootValues = {
  baseColor: [0.7, 0.7, 0.7, 1],
  baseColorUvTransform: [0, 0, 1, 1],
};
const derivedValues = {
  baseColor: [0.2, 0.55, 0.95, 1],
  baseColorUvTransform: [0, 0, 1, 1],
};
const artifactPath = () => `materials/programs/${artifactDigest.slice(7)}.wgsl`;

function record(guid, authored, resolvedValues, parent) {
  const resolved = { passes, parameters, values: resolvedValues };
  const programs = [
    {
      specializationKey: MODULE_ID,
      artifact: {
        mediaType: 'text/wgsl',
        path: artifactPath(),
        digest: artifactDigest,
        bytes: artifactBytes,
      },
      // This custom program declares no atmosphere-dependent code; both device
      // capabilities consume these identical producer-compiled bytes.
      selections: ['storage-buffer', 'storage-buffer-atmosphere'].map(capability => ({
        pass: 'Forward', context: { ...PROGRAM_CONTEXT, capability },
      })),
    },
  ];
  const programSetDigest = createMaterialProgramSetDigest(programs, passes);
  const inputDigest = digest({
    module: MODULE_ID,
    sourceClosure: SOURCE_CLOSURE,
    artifactDigest: programSetDigest,
    layoutIdentity,
  });
  const materialContractDigest = digest(parameters);
  const programIdentity = digest({ module: MODULE_ID, layoutIdentity });
  const pipelineIdentity = digest({ programIdentity, renderState: passes.map((pass) => pass.renderState) });
  const materialPublicationIdentity = digest({ guid, values: resolvedValues });
  const identity = createMaterialCookIdentity({
    materialContractDigest,
    sourceRevision: inputDigest,
    sourceClosureDigest: inputDigest,
    layoutIdentity,
    programIdentity,
    pipelineIdentity,
    materialPublicationIdentity,
    compilerFingerprint: 'forgeax-material-cooker/1',
    wasm: { sourceContentKey: 'unavailable', artifactSha256: 'unavailable', glueSha256: 'unavailable' },
    artifactDigest: programSetDigest,
    valueGeneration: 1,
    dependencyGeneration: 1,
    cookGeneration: 1,
  });
  return {
    schemaVersion: 'material-cook/4',
    guid,
    materialGuid: guid,
    publicationGeneration: 1,
    specializationKey: MODULE_ID,
    artifactDigest: programSetDigest,
    sourceClosure: SOURCE_CLOSURE,
    parameterContract: { parameters, values: resolvedValues },
    authored,
    resolved,
    refs: {
      parent: parent === undefined ? [] : [parent],
      textures: [],
      samplers: [],
      modules: [MODULE_ID],
    },
    programs,
    receipt: {
      schemaVersion: 'material-cook/4',
      sourceClosure: SOURCE_CLOSURE,
      profile: 'webgpu/v1',
      compilerVersion: 'forgeax-material-cooker/1',
      identity,
      derivedInterface: { layoutIdentity },
    },
  };
}

const rootAuthored = { kind: 'material', passes, parameters, values: rootValues };
const derivedAuthored = { kind: 'material', parent: ROOT_GUID, values: derivedValues };
const root = record(ROOT_GUID, rootAuthored, rootValues);
const derived = record(DERIVED_GUID, derivedAuthored, { ...rootValues, ...derivedValues }, ROOT_GUID);
const rows = new Map([[ROOT_GUID, root], [DERIVED_GUID, derived]]);
for (const asset of fixture.assets ?? []) {
  const cooked = rows.get(asset.guid);
  if (asset.kind === 'material' && cooked !== undefined) asset.payload.cooked = cooked;
}

if (writeFixture) writeFileSync(FIXTURE_PATH, `${jsonWithBytes(fixture)}\n`);
console.log(JSON.stringify({
  status: 'pass',
  producer: 'vite-plugin-shader manifest + material-cook/4 inheritance publication',
  shaderIdentifier: MODULE_ID,
  artifactBytes: artifactBytes.byteLength,
  artifactDigest,
  layoutIdentity,
  fixtureWritten: writeFixture,
  ...(writeFixture ? { fixturePath: FIXTURE_PATH } : {}),
}));
