import assert from 'node:assert/strict';
import { it } from 'node:test';
import { compiledAssetReferenceProgram } from '../scripts/asset-reference-program.mjs';
import { parseImports } from '../scripts/check-architecture.mjs';

it('the packaged query has one TypeScript source and only admitted native module imports', async () => {
  const source = await compiledAssetReferenceProgram();
  const parsed = parseImports('asset-reference-query.mjs', source);
  assert.deepEqual(parsed.diagnostics, []);
  assert(parsed.imports.length > 0);
  for (const edge of parsed.imports) assert.ok([
    '@forgeax/engine/plugin', '@forgeax/engine/ecs', '@forgeax/engine/types', '@forgeax/engine/pack/source',
  ].includes(edge.specifier), `Unexpected program edge: ${edge.specifier}`);
  assert.match(source, /world\.sharedRefs\.resolve/);
  assert.match(source, /assets\.guidOf/);
  assert(!/world\.(?:spawn|despawn|set|allocSharedRef)\(/.test(source));
});
