#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePackSourceJson, projectDirectPackJson } from '@forgeax/engine-pack/source';
import { captureMaterialSourceSnapshot, createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { projectPackSourceClosure } from '../../../../scripts/forgeax/repository-public-policy.mjs';

const app = fileURLToPath(new URL('..', import.meta.url));
const root = resolve(app, 'src');
const sourcePath = resolve(root, 'pulse-material.pack.json');
const fixturePath = resolve(app, 'fixtures/pulse-material.runtime-pack.json');
const writeFixture = process.argv.includes('--write');
const alternate = process.argv.includes('--alternate');
const parsed = parsePackSourceJson(JSON.parse(await readFile(sourcePath, 'utf8'))).unwrap();
if (parsed.format !== 'direct') throw new Error('Expected the direct pulse material Pack');
const { assets } = projectDirectPackJson(parsed);
const table = Object.fromEntries(assets.filter((asset) => asset.kind === 'material').map((asset) => [asset.guid, asset.payload]));
const sourceSnapshot = alternate
  ? await captureMaterialSourceSnapshot([root], {
      async readText(path) {
        const source = await readFile(path, 'utf8');
        if (path !== resolve(root, 'pulse-material.wgsl')) return source;
        const variant = source.replace('* 0.25 + 0.75;', '* 0.25 + 0.7505;');
        if (variant === source) throw new Error('Missing alternate pulse brightness input');
        return variant;
      },
    })
  : undefined;
const wasm = JSON.parse(await readFile(resolve(app, '../../../packages/wgpu-wasm/pkg/provenance.json'), 'utf8'));
const cooker = createMaterialPackCooker([root], sourceSnapshot === undefined ? {} : { sourceSnapshot });
const rows = [];
const publications = [];
for (const { guid, sourceKey, kind, payload, refs } of assets) {
  if (kind !== 'material') {
    rows.push({ guid, sourceKey, kind, payload, refs, artifacts: {} });
    continue;
  }
  const draft = await cooker.cook({ guid, source: payload, table, sourcePath, sourceKey, refs, wasm, compilerFingerprint: wasm.compilerFingerprint });
  const record = draft.payload.cooked;
  if (record === undefined) throw new Error(`Missing compiled publication for ${guid}`);
  rows.push({ guid, sourceKey, kind, payload: draft.payload, refs: draft.refs, artifacts: {} });
  publications.push({ guid, artifactDigest: record.artifactDigest, cookIdentity: record.receipt.identity.cookIdentity });
}
const fixture = { schemaVersion: '2.0.0', kind: 'internal-text-package', assets: rows };
const json = JSON.stringify(fixture, (_key, value) => value instanceof Uint8Array ? [...value] : value);
if (writeFixture) await writeFile(fixturePath, `${JSON.stringify(projectPackSourceClosure(JSON.parse(json)))}\n`);
console.log(JSON.stringify({ status: 'pass', publications, fixtureWritten: writeFixture }));
