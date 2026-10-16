import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normaliseForPack, textureAssetOutputProducer } from '@forgeax/engine-import';
import { createRuntimePackPublication, projectPackageCatalog } from '@forgeax/engine-pack/runtime';
import { decodeCatalogWire } from '@forgeax/engine-pack';
import { createVfxVectorFieldTexture } from '@forgeax/engine-vfx-compiler';
import { fieldGuid } from '../src/field-guids.ts';

// CPU producer preparation runs before admission to the physical GPU lease.
const output = resolve(process.argv[2] ?? resolve(import.meta.dirname, '../artifacts/field-replacement-inputs'));
const unwrap = result => { if (!result.ok) throw result.error; return result.value; };
const index = unwrap(decodeCatalogWire(JSON.parse(readFileSync(resolve(import.meta.dirname, '../dist/pack-index.json'), 'utf8'))));
const guid = fieldGuid('field/constant/8');
const previous = index.find(row => row.guid === guid);
assert(previous, 'ordinary built Catalog must contain the saved constant Texture');
const texture = unwrap(createVfxVectorFieldTexture({ resolution: [8, 8, 8], field: { kind: 'constant', value: [-0.5, 0.25, -0.125] } }));
const product = unwrap(await textureAssetOutputProducer.produce({ guid, sourceKey: previous.sourceKey, asset: texture }));
const body = product.artifacts.body;
assert(body, 'ordinary Texture producer must emit its binary artifact');
const digest = `sha256:${createHash('sha256').update(body.bytes).digest('hex')}`;
const revision = {
  digest, observedAt: Date.now(), rootId: previous.revision?.rootId ?? previous.sourcePath,
};
assert(revision.observedAt > (previous.revision?.observedAt ?? 0),
  'replacement producer must observe a new revision after its accepted baseline');
const packageUrl = 'http://127.0.0.1/roi21-replacement/fields.pack.json';
const prepared = createRuntimePackPublication({
  scopeId: 'roi21-native-reimport', sourcePath: previous.sourcePath,
  sourceRevision: digest, packageUrl, sourceKeys: new Map([[guid, previous.sourceKey]]),
  pack: { assets: [{ guid, kind: 'texture', payload: normaliseForPack(product.payload), refs: [],
    artifacts: { body: { path: 'field.bin', mediaType: body.mediaType, assetCodec: body.assetCodec,
      byteLength: body.bytes.byteLength, integrity: { algorithm: 'sha256', digest } } } }] },
});
const [row] = projectPackageCatalog([{
  guid, kind: 'texture', sourcePath: previous.sourcePath, sourceKey: previous.sourceKey,
  provenance: previous.provenance, revision, execution: 'direct', refs: [],
}], packageUrl);
mkdirSync(output, { recursive: true });
writeFileSync(resolve(output, 'field.bin'), body.bytes);
writeFileSync(resolve(output, 'fields.pack.json'), `${JSON.stringify(prepared.pack, null, 2)}\n`);
writeFileSync(resolve(output, 'catalog-row.json'), `${JSON.stringify({ ...row, publication: prepared.publication }, null, 2)}\n`);
writeFileSync(resolve(output, 'producer-receipt.json'), `${JSON.stringify({ guid, previous, packageUrl,
  value: [-0.5, 0.25, -0.125], bodyBytes: body.bytes.byteLength, digest, revision, publication: prepared.publication }, null, 2)}\n`);
console.log(`[fields-replacement] prepared ordinary producer/Pack/Catalog artifacts: ${output}`);
