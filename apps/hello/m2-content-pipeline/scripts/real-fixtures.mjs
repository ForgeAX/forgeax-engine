#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { fbxImporter } from '@forgeax/engine-fbx';

const here = resolve(fileURLToPath(new URL('.', import.meta.url)));
const root = resolve(here, '..', '..', '..', '..');
const source = resolve(root, 'forgeax-engine-assets/vendor/fbx-test/cube.fbx');
const meta = JSON.parse(readFileSync(`${source}.meta.json`, 'utf8'));
const original = new Uint8Array(readFileSync(source));

async function importBytes(bytes) {
  return fbxImporter.import({
    source,
    readSource: async () => ({ ok: true, value: bytes }),
    readSibling: async () => ({ ok: false, error: new Error('FBX fixture has no external siblings') }),
    decodeImage: async () => ({ ok: false, error: new Error('FBX fixture has no image siblings') }),
    subAssets: meta.subAssets,
    importSettings: meta.importSettings,
  });
}

const first = await importBytes(original);
if (!first.ok) throw new Error(`[m2-content] FBX first import failed: ${first.error.code}`);

// Appending one ignored padding byte mutates the source bytes while keeping the
// FBX document valid. The importer must preserve the sidecar's declared GUIDs.
const mutated = new Uint8Array(original.length + 1);
mutated.set(original);
const second = await importBytes(mutated);
if (!second.ok) throw new Error(`[m2-content] FBX reimport failed after source mutation: ${second.error.code}`);

const firstGuids = first.value.assets.map((asset) => asset.guid).sort();
const secondGuids = second.value.assets.map((asset) => asset.guid).sort();
const declaredGuids = meta.subAssets.map((asset) => asset.guid).sort();
if (JSON.stringify(firstGuids) !== JSON.stringify(declaredGuids) || JSON.stringify(secondGuids) !== JSON.stringify(declaredGuids)) {
  throw new Error('[m2-content] FBX reimport changed the declared GUID set');
}
if (first.value.assets.length !== second.value.assets.length) {
  throw new Error('[m2-content] FBX reimport changed the produced asset count');
}

const fontDir = resolve(root, 'forgeax-engine-assets/dejavu-fonts');
const fontBytes = readFileSync(resolve(fontDir, 'DejaVuSansMono.ttf'));
const fontPack = JSON.parse(readFileSync(resolve(fontDir, 'DejaVuSansMono.font.pack.json'), 'utf8'));
const fontAsset = fontPack.assets.find((asset) => asset.kind === 'font');
const glyphCount = Object.keys(fontAsset?.payload?.glyphs ?? {}).length;
if (fontAsset === undefined || glyphCount < 90) throw new Error('[m2-content] pre-baked font pack has no printable glyph payload');
if (typeof fontAsset.payload.atlasGuid !== 'string' || typeof fontAsset.payload.samplerGuid !== 'string') {
  throw new Error('[m2-content] pre-baked font pack lost atlas/sampler identity');
}

console.log(`[m2-content] FBX fixture reimport: PASS bytes=${original.length}->${mutated.length} assets=${second.value.assets.length} stableGuids=true`);
console.log(`[m2-content] font fixture delivery: PASS ttfBytes=${fontBytes.length} glyphs=${glyphCount} preBaked=true`);
