import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const engineRoot = resolve(repositoryRoot, 'packages/engine');
const manifest = JSON.parse(await readFile(resolve(engineRoot, 'package.json'), 'utf8'));
if (!manifest.exports['./*']) throw new Error('focused-subpath-export-missing');

const consumerRoot = await mkdtemp(resolve(tmpdir(), 'forgeax-material-consumer-'));
try {
  await writeFile(
    resolve(consumerRoot, 'package.json'),
    JSON.stringify({ type: 'module', private: true }, null, 2),
  );
  await mkdir(resolve(consumerRoot, 'node_modules/@forgeax'), { recursive: true });
  await symlink(engineRoot, resolve(consumerRoot, 'node_modules/@forgeax/engine'), 'dir');
  await writeFile(
    resolve(consumerRoot, 'consumer.mjs'),
    `import { Materials } from '@forgeax/engine/render';
import { collectMaterialCookRefs } from '@forgeax/engine/pack';
import { assertMaterialAsset } from '@forgeax/engine/types';

const material = Materials.standard({
  surfaceModule: 'game_3d::rusted_iron_surface',
  parameters: [],
  values: {},
});
assertMaterialAsset(material);
const wire = JSON.stringify(material);
for (const field of ['SurfaceAsset', 'shadingModel', 'surfaceModule']) {
  if (wire.includes(field)) throw new Error('duplicate-wire-field:' + field);
}
if (material.passes[0].program.module !== 'forgeax_material::standard') {
  throw new Error('standard-module-identity-mismatch');
}
if (material.passes[0].program.moduleSlots?.surface !== 'game_3d::rusted_iron_surface') {
  throw new Error('surface-slot-missing');
}
collectMaterialCookRefs(material);
`,
  );
  await run(process.execPath, [resolve(consumerRoot, 'consumer.mjs')], { cwd: consumerRoot });
  console.log(
    JSON.stringify({
      status: 'pass',
      consumer: 'clean temporary project with linked published engine package',
      focusedSubpaths: ['@forgeax/engine/render', '@forgeax/engine/pack', '@forgeax/engine/types'],
    }),
  );
} finally {
  await rm(consumerRoot, { recursive: true, force: true });
}
