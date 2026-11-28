import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCapture } from '@forgeax/engine-modeling/tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
let directory = '';
beforeAll(async () => {
  directory = await mkdtemp(join(root, '.isolation-export-normals-'));
  for (const kind of ['mesh', 'rig'])
    await writeFile(
      join(directory, `${kind}.pack.ts`),
      `
import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { model, rig, sel } from '@forgeax/engine-modeling';
const packageId = definePackageId('01900000-0000-7000-8000-00000000a0f7');
export default definePack({ schemaVersion: '2.0.0', packageId, build() {
  const m = model(); m.box({ size: [1, 1, 1] }); m.uv.project({ mode: 'box', scale: 1 });
  ${
    kind === 'mesh'
      ? "return m.finish({ key: 'cube', normals: { mode: 'flat' } });"
      : `
  const r = rig(m, { joints: [{ name: 'root', parent: null, position: [0, 0, 0] }] });
  r.bindRigid(sel.all(), 'root');
  return r.finish({ key: 'cube', packageId, form: 'skinned', normals: { mode: 'flat' } });`
  }
} });
`,
    );
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('capture exported shading', () => {
  for (const kind of ['mesh', 'rig'])
    it(`preserves authored flat normals for a ${kind}`, { timeout: 60000 }, async () => {
      const result = await runCapture({
        sourcePath: join(directory, `${kind}.pack.ts`),
        render: true,
      });
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      const mesh = result.value.render?.mesh;
      const normals = mesh?.attributes.normal as Float32Array;
      expect(normals.length).toBe(24 * 3);
      for (let i = 0; i < normals.length; i += 3) {
        const components = [...normals.slice(i, i + 3)].map(Math.abs).sort();
        expect(components).toEqual([0, 0, 1]);
      }
    });
});
