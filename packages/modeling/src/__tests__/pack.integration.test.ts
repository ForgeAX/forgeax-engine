import { definePack, definePackageId, executePackBuild } from '@forgeax/engine-pack/source';
import type { MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { model } from '../model';
import { sel } from '../selectors';

const packageId = definePackageId('01900000-0000-7000-8000-00000000a0de');

const helmet = definePack({
  schemaVersion: '2.0.0',
  packageId,
  parameters: [
    { name: 'width', type: 'f32', default: 0.42, minimum: 0.1, maximum: 2 },
    { name: 'depth', type: 'f32', default: 0.03, minimum: 0.005, maximum: 0.1 },
  ],
  build: ({ values: p }) => {
    const m = model();
    m.box({ size: [p.width as number, 0.3, 0.36], tag: 'shell' });
    m.inset(sel.tag('shell').and(sel.facing('+z', 10)).largest().one(), {
      thickness: 0.02,
      region: 'merged',
      label: 'visor',
    });
    m.extrude(sel.createdBy('visor', 'inner'), {
      distance: -(p.depth as number),
      region: 'merged',
      label: 'visor-depth',
    });
    m.markSharp(sel.edges.dihedral('>', 40));
    m.uv.project({ mode: 'box', scale: 0.5 });
    m.assign(sel.createdBy('visor-depth', 'top'), 'glow');
    return m.finish({ key: 'helmet', normals: { mode: 'weighted' } });
  },
});

describe('ScriptablePack integration', () => {
  it('a .pack.ts build produces an ordinary mesh output', async () => {
    const result = await executePackBuild(helmet, {
      packageId,
      readByGuid: async () => {
        throw new Error('no reads expected');
      },
      values: { width: 0.42, depth: 0.03 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const mesh = result.value['mesh/helmet'] as MeshAsset;
    expect(mesh.kind).toBe('mesh');
    expect(mesh.materialSlots.map((slot) => slot.slotName)).toEqual(['Default', 'glow']);
    expect(mesh.submeshes).toHaveLength(2);
    expect(mesh.aabb).toBeDefined();
  });

  it('parameter overrides change geometry deterministically', async () => {
    const run = async (width: number) => {
      const result = await executePackBuild(helmet, {
        packageId,
        readByGuid: async () => {
          throw new Error('no reads expected');
        },
        values: { width, depth: 0.03 },
      });
      if (!result.ok) throw result.error;
      return result.value['mesh/helmet'] as MeshAsset;
    };
    const a = await run(0.42);
    const b = await run(0.42);
    const c = await run(0.6);
    expect(Array.from(a.vertices)).toEqual(Array.from(b.vertices));
    expect(a.aabb?.[3]).toBeCloseTo(0.21, 6);
    expect(c.aabb?.[3]).toBeCloseTo(0.3, 6);
  });
});

describe('live generation isolation', () => {
  it('an isolated Worker build may import the modeling kernel', async () => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { loadScriptablePack } = await import('@forgeax/engine-pack/source-node');
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const directory = await mkdtemp(join(root, '.isolation-'));
    try {
      const path = join(directory, 'isolated.pack.ts');
      await writeFile(
        path,
        `import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { model, sel } from '@forgeax/engine-modeling';
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-00000000a0df'),
  parameters: [
    { name: 'height', type: 'f32', default: 1, minimum: 0.1, maximum: 4 },
    { name: 'hysteresis', type: 'f32', default: 0.1, apply: { asset: 'mesh/crate', path: ['lodHysteresis'] } },
  ],
  build({ values }) {
    const m = model();
    m.box({ size: [1, values.height, 1] });
    m.extrude(sel.facing('+y'), { distance: 0.25, region: 'merged', label: 'lid' });
    m.uv.project({ mode: 'box', scale: 1 });
    return m.finish({ key: 'crate' });
  },
});
`,
      );
      const loaded = await loadScriptablePack(path);
      if (!loaded.ok) throw loaded.error;
      const definition = loaded.value;
      const built = await (definition.build as (context: unknown) => Promise<unknown>)({
        packageId: definition.packageId,
        values: { height: 2 },
        readByGuid: async () => ({ ok: false }),
      });
      expect(built).toMatchObject({ ok: true, value: { 'mesh/crate': { kind: 'mesh' } } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
