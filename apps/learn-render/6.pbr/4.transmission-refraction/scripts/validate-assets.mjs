import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGltf, toMaterialAsset } from '@forgeax/engine-gltf';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = ['material-transmission.pack.json', 'material-transmission-gltf.pack.json'];
const source = JSON.parse(await readFile(resolve(root, 'assets', 'material-transmission.gltf.json'), 'utf8'));
const parsed = await parseGltf(source, async () => new ArrayBuffer(0), 'material-transmission.gltf.json');
if (!parsed.ok || parsed.value.materials.length !== 1) {
  throw new Error(`gltf source parse failed: ${parsed.ok ? 'material-count' : parsed.error.code}`);
}
const expected = toMaterialAsset(parsed.value.materials[0]).values;

const entries = [];
for (const file of files) {
  const pack = JSON.parse(await readFile(resolve(root, 'assets', file), 'utf8'));
  if (pack.kind !== 'internal-text-package' || !Array.isArray(pack.assets) || pack.assets.length !== 1) {
    throw new Error(`${file}: expected one internal-text-package asset`);
  }
  const asset = pack.assets[0];
  if (asset.kind !== 'material' || asset.payload?.passes?.[0]?.program?.module !== 'forgeax::default-standard-pbr') {
    throw new Error(`${file}: not a Standard material producer payload`);
  }
  const expectedValues = file === 'material-transmission-gltf.pack.json'
    ? expected
    : {
        baseColor: [0.76, 0.9, 1, 1],
        metallic: 0,
        roughness: 0.06,
        transmission: 1,
        ior: 1.45,
        thickness: 0.12,
        attenuationColor: [0.9, 0.97, 1],
        attenuationDistance: 3,
      };
  if (JSON.stringify(asset.payload.values) !== JSON.stringify(expectedValues)) {
    throw new Error(`${file}: producer value projection drifted`);
  }
  entries.push({ file, guid: asset.guid, sourceKey: asset.sourceKey });
}
if (entries[0].guid === entries[1].guid || entries[0].sourceKey === entries[1].sourceKey) {
  throw new Error('authored and glTF producer identities must remain distinct');
}

console.log(JSON.stringify({
  executionPath: 'node:carrier-pack-validation',
  observed: { source: 'material-transmission.gltf.json', files: entries, standardValues: expected },
  verdict: 'pass',
  confidence: 'high',
}, null, 2));
