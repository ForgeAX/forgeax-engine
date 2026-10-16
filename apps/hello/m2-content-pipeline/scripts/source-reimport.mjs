#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { fbxImporter } from '@forgeax/engine-fbx';
import { gltfImporter } from '@forgeax/engine-gltf';
import { ImporterRegistry, runImport } from '@forgeax/engine-import';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import * as UPNG from 'upng-js';

const here = resolve(fileURLToPath(new URL('.', import.meta.url)));
const root = resolve(here, '..', '..', '..', '..');

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function bytes(path) {
  return new Uint8Array(readFileSync(path));
}

function digest(result) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(result.pack.assets));
  for (const [guid, payload] of [...(result.bins ?? new Map())].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(guid);
    hash.update(payload);
  }
  return hash.digest('hex').slice(0, 16);
}

function guidSet(result) {
  return result.pack.assets.map((asset) => asset.guid).sort().join(',');
}

async function importOnce(importer, meta, sourceBytes) {
  const registry = new ImporterRegistry();
  registry.register(importer);
  const result = await runImport(meta, registry, {
    readSource: async () => ({ ok: true, value: sourceBytes }),
  });
  if (!result.ok) {
    throw new Error(`${meta.importer} import failed: ${result.error.code}`);
  }
  if ('skipped' in result.value) {
    throw new Error(`${meta.importer} import was unexpectedly skipped`);
  }
  return result.value;
}

async function prove(label, importer, meta, original, mutated) {
  const first = await importOnce(importer, meta, original);
  const repeat = await importOnce(importer, meta, original);
  const second = await importOnce(importer, meta, mutated);
  const firstGuids = guidSet(first);
  const repeatGuids = guidSet(repeat);
  const secondGuids = guidSet(second);
  const firstDigest = digest(first);
  const repeatDigest = digest(repeat);
  const secondDigest = digest(second);
  if (firstGuids !== repeatGuids || firstDigest !== repeatDigest) {
    throw new Error(`${label} identical source was not deterministic`);
  }
  if (firstGuids !== secondGuids) {
    throw new Error(`${label} changed GUID set: ${firstGuids} -> ${secondGuids}`);
  }
  if (firstDigest === secondDigest) {
    throw new Error(`${label} source mutation did not change imported semantics`);
  }
  console.log(`[m2-content] ${label}: PASS stableGuids=true semanticDigest=${firstDigest}->${secondDigest}`);
}

const imageSource = resolve(root, 'forgeax-engine-assets/learn-opengl/objects/planet/mars.png');
const imageMeta = json(`${imageSource}.meta.json`);
const imageOriginal = bytes(imageSource);
const upng = UPNG.default ?? UPNG;
const decoded = upng.decode(imageOriginal);
const frames = upng.toRGBA8(decoded);
const rgba = new Uint8Array(frames[0]);
rgba[0] = rgba[0] === 255 ? 0 : 255;
const imageMutated = new Uint8Array(upng.encode([rgba.buffer], decoded.width, decoded.height, 0));
await prove('image source reimport', imageImporter, imageMeta, imageOriginal, imageMutated);

const gltfSource = resolve(root, 'apps/hello/gltf/assets/box.gltf');
const gltfMeta = json(`${gltfSource}.meta.json`);
const gltfDocument = json(gltfSource);
const gltfMutatedDocument = structuredClone(gltfDocument);
gltfMutatedDocument.materials[0].pbrMetallicRoughness.baseColorFactor = [0.1, 0.8, 0.3, 1];
const gltfOriginal = new TextEncoder().encode(JSON.stringify(gltfDocument));
const gltfMutated = new TextEncoder().encode(JSON.stringify(gltfMutatedDocument));
await prove('gltf source reimport', gltfImporter, gltfMeta, gltfOriginal, gltfMutated);

const fbxSource = resolve(root, 'forgeax-engine-assets/vendor/fbx-test/cube.fbx');
const fbxMeta = json(`${fbxSource}.meta.json`);
const fbxOriginal = bytes(fbxSource);
const fbxText = new TextDecoder().decode(fbxOriginal);
const translation = 'P: "Lcl Translation", "Lcl Translation", "", "A+",0,0,0';
if (fbxText.split(translation).length !== 2) {
  throw new Error('FBX fixture did not contain exactly one semantic translation property');
}
const fbxMutated = new TextEncoder().encode(
  fbxText.replace(translation, 'P: "Lcl Translation", "Lcl Translation", "", "A+",0.5,0,0'),
);
await prove('FBX source reimport', fbxImporter, fbxMeta, fbxOriginal, fbxMutated);

console.log('[m2-content] source reimport: PASS image+gltf+fbx semantic mutation with stable GUIDs');
