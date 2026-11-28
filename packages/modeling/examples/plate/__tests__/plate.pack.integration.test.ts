import { fileURLToPath } from 'node:url';
import { createMeshJobCooker, MESH_JOB_COOK_KIND } from '@forgeax/engine-modeling';
import { NativeCookerRegistry } from '@forgeax/engine-pack/native-cooker';
import { executePackBuild, type PackCookSource, resolvePackParameterValues } from '@forgeax/engine-pack/source';
import { loadScriptablePack } from '@forgeax/engine-pack/source-node';
import type { MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { PLATE_DEFAULTS, PLATE_JOB, buildPlate } from '../plate';

const PACK = fileURLToPath(new URL('../plate.pack.ts', import.meta.url));
/** The default ScriptablePack build timeout (`loadScriptablePack` buildTimeoutMs). */
const BUILD_BUDGET_MS = 15_000;
/** The Pack build only declares the job; the Shape and its mesh are built in the cooker. */
const BUILD_FRACTION = 0.1;

async function build(values: Readonly<Record<string, number>>) {
  const loaded = await loadScriptablePack(PACK);
  if (!loaded.ok) throw loaded.error;
  const definition = loaded.value;
  const started = performance.now();
  const result = await executePackBuild(definition, {
    packageId: definition.packageId,
    readByGuid: async () => ({ ok: false }),
    values: resolvePackParameterValues(definition as never, values).unwrap(),
  } as never);
  const ms = performance.now() - started;
  if (!result.ok) throw Object.assign(new Error('the plate Pack build failed'), { cause: result.error, ms });
  return { outputs: result.value as Readonly<Record<string, unknown>>, ms };
}

describe('C-700 Pack build within its budget (design 10.4), exact stage in the cooker', () => {
  it('builds at the parameter extremes well inside the 15 s budget, deferring the mesh job', { timeout: 120000 }, async () => {
    for (const values of [{ width: 1, depth: 1, thickness: 0.1 }, { width: 0.05, depth: 0.05, thickness: 0.002 }]) {
      const { outputs, ms } = await build(values);
      expect(Object.keys(outputs)).toEqual(['mesh/plate']);
      const entry = outputs['mesh/plate'] as PackCookSource;
      expect(entry).toMatchObject({ kind: MESH_JOB_COOK_KIND, execution: 'cooked', source: { job: PLATE_JOB.name, key: 'plate', params: values } });
      expect(ms, `build at ${JSON.stringify(values)}`).toBeLessThan(BUILD_BUDGET_MS * BUILD_FRACTION);
    }
  });

  it('cooks the deferred source to the same mesh bytes as the in-place build', { timeout: 300000 }, async () => {
    const { outputs } = await build({});
    const entry = outputs['mesh/plate'] as PackCookSource;
    const registry = new NativeCookerRegistry();
    registry.register(createMeshJobCooker([PLATE_JOB]));
    const draft = await registry.runDraft('modeling-mesh-job', {
      guid: '01900000-0000-7000-8000-0000000c0700',
      source: JSON.parse(JSON.stringify(entry.source)),
    });
    if (!draft.ok) throw new Error(JSON.stringify(draft.error));
    const cooked = draft.value.payload as MeshAsset;
    const direct = buildPlate(PLATE_DEFAULTS).finish({ key: 'plate', ...PLATE_JOB.export });
    if (!direct.ok) throw direct.error;
    const expected = direct.value['mesh/plate'] as MeshAsset;
    expect(cooked.kind).toBe('mesh');
    expect(Buffer.from(cooked.vertices.buffer, cooked.vertices.byteOffset, cooked.vertices.byteLength).equals(Buffer.from(expected.vertices.buffer, expected.vertices.byteOffset, expected.vertices.byteLength))).toBe(true);
    expect(Array.from(cooked.indices ?? [])).toEqual(Array.from(expected.indices ?? []));
    expect(cooked.submeshes).toEqual(expected.submeshes);
    expect(cooked.submeshes).toHaveLength(2);
  });
});
