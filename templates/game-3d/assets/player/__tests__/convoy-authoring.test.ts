import { fileURLToPath } from 'node:url';
import { loadScriptablePack } from '@forgeax/engine/pack/source-node';
import { expect, it } from 'vitest';

it.each(['scene', 'character'])('loads the %s Pack through isolated source generation', { timeout: 30000 }, async name => {
  const source = fileURLToPath(new URL(`../../${name}.pack.ts`, import.meta.url));
  const loaded = await loadScriptablePack(source);
  if (!loaded.ok) throw loaded.error;
  if (name === 'character') {
    // Exercise the real Worker build with its normal producer deadline, not
    // just module metadata. Texture recipes stay deferred to the cooker.
    const built = await loaded.value.build({
      packageId: loaded.value.packageId,
      values: {},
      readByGuid: async () => { throw new Error('Character generation must be self-contained'); },
    });
    if (!built.ok) throw built.error;
    expect(built.value).toHaveProperty('mesh/player.kind', 'mesh');
    expect(built.value).toHaveProperty('texture/convoy-normal.execution', 'cooked');
  }
});
