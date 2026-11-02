import { fileURLToPath } from 'node:url';
import { executePackBuild } from '@forgeax/engine-pack/source';
import { loadScriptablePack } from '@forgeax/engine-pack/source-node';
import type { MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

const PACK = fileURLToPath(new URL('../body.pack.ts', import.meta.url));
/** The default ScriptablePack build timeout (`loadScriptablePack` buildTimeoutMs). */
const BUILD_BUDGET_MS = 15_000;

describe('C-114 quality-body Pack', () => {
  it('builds the correct and the wrong body inside the build budget, without a cooker', { timeout: 120000 }, async () => {
    const loaded = await loadScriptablePack(PACK);
    if (!loaded.ok) throw loaded.error;
    const definition = loaded.value;
    const started = performance.now();
    const result = await executePackBuild(definition, {
      packageId: definition.packageId,
      readByGuid: async () => ({ ok: false }),
      values: {},
    } as never);
    const ms = performance.now() - started;
    if (!result.ok) throw Object.assign(new Error('the quality-body Pack build failed'), { cause: result.error });
    const outputs = result.value as Readonly<Record<string, MeshAsset>>;
    expect(Object.keys(outputs).sort()).toEqual(['mesh/quality-body-correct', 'mesh/quality-body-wrong']);
    for (const mesh of Object.values(outputs)) expect(mesh.indices?.length ?? 0).toBeGreaterThan(0);
    expect(ms).toBeLessThan(BUILD_BUDGET_MS);
  });
});
