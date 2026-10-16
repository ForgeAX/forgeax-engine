#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
const APP_ROOT = resolve(new URL('..', import.meta.url).pathname);
const FIXTURE_PATH = resolve(APP_ROOT, 'assets/pulse-material.pack.json');
const WASM_PROVENANCE_PATH = resolve(APP_ROOT, '../../../packages/wgpu-wasm/pkg/provenance.json');
const writeFixture = process.argv.includes('--write');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function jsonWithBytes(value) {
  return JSON.stringify(value, (_key, entry) =>
    entry instanceof Uint8Array ? [...entry] : entry,
  );
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const wasm = JSON.parse(readFileSync(WASM_PROVENANCE_PATH, 'utf8'));
const cooker = createMaterialPackCooker([resolve(APP_ROOT, 'src')]);
const publications = [];
const materialRows = (fixture.assets ?? []).filter(
  (asset) => asset?.kind === 'material' && asset.payload?.kind === 'material',
);
const authoredMaterial = (payload) => {
  const { kind, parent, colorSpace, passes, parameters, values } = payload;
  if (parent !== undefined) {
    assert(typeof parent === 'string', 'derived material parent must be a GUID');
    return { kind, parent, values };
  }
  return {
    kind,
    ...(colorSpace === undefined ? {} : { colorSpace }),
    passes,
    parameters,
    values,
  };
};
const authoredTable = Object.fromEntries(
  materialRows.map((asset) => {
    assert(typeof asset.guid === 'string', 'material row GUID is required');
    return [asset.guid, authoredMaterial(asset.payload)];
  }),
);
for (const asset of materialRows) {
  const guid = asset.guid;
  const authored = authoredTable[guid];
  assert(authored !== undefined, `material source is missing for ${guid}`);
  const draft = await cooker.cook({
    guid,
    source: authored,
    table: authoredTable,
    sourcePath: FIXTURE_PATH,
    sourceKey: '../src/pulse-material.wgsl',
    refs: [],
    compilerFingerprint: wasm.compilerFingerprint,
    wasm,
  });
  const record = draft.payload.cooked;
  assert(record !== undefined, `pack producer did not publish ${guid}`);
  asset.payload = { ...authored, cooked: record };
  publications.push({
    guid: record.guid,
    artifactDigest: record.artifactDigest,
    cookIdentity: record.receipt.identity.cookIdentity,
  });
}

const output = `${jsonWithBytes(fixture)}\n`;
if (writeFixture) writeFileSync(FIXTURE_PATH, output);
const summary = {
  status: 'pass',
  producer: 'shader-compiler Pack material cooker',
  publications,
  fixtureWritten: writeFixture,
  ...(writeFixture ? { fixturePath: FIXTURE_PATH } : {}),
};
console.log(JSON.stringify(summary));
