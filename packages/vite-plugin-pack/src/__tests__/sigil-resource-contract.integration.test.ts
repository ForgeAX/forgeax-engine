import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import type { MaterialAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';

it.each(
  ['hello/boss-lightning', 'game-capability-lab'].flatMap((owner) =>
    ['arc-nova-sigil', 'arc-nova-violet-sigil'].map((name) => ({ owner, name })),
  ),
)('cooks $owner/$name as a depth-only resource interface', async ({ owner, name }) => {
  const sourcePath = fileURLToPath(
    new URL(`../../../../apps/${owner}/assets/${name}.shader.pack.json`, import.meta.url),
  );
  const document = JSON.parse(await readFile(sourcePath, 'utf8'));
  const asset = Array.isArray(document.assets)
    ? document.assets[0]
    : Object.values(document.assets)[0];
  const source = (asset as { payload: MaterialAsset }).payload;
  const cooked = await createMaterialPackCooker([dirname(sourcePath)]).cook({
    guid: 'sigil-resource-contract',
    source,
    sourcePath,
    sourceKey: `${name}.wgsl`,
  });
  const record = validateCookedMaterialRecord(
    (cooked.payload as { cooked: unknown }).cooked,
  ).unwrap();
  const selections = record.programs.flatMap((program) => program.selections);
  expect(selections.length).toBeGreaterThan(0);
  for (const selection of selections) {
    expect(selection.abi?.bindings).toBe('group-0-resource');
    expect(selection.abi?.sceneDepth).toBe('read-only');
  }
});
