import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCapture } from '@forgeax/engine-modeling/tools';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const PACKAGE = '01900000-0000-7000-8000-00000000a0f1';
const guid = (key: string) => AssetGuid.format(AssetGuid.derive(definePackageId(PACKAGE), key));
let directory = '';

// Each build numbers its slot, so a mesh and a material from different builds cannot match.
const PACK = (
  withMaterials: boolean,
) => `import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { AssetGuid } from '@forgeax/engine-pack/source';
import { model, sel, textureFrom } from '@forgeax/engine-modeling';
import { Materials } from '@forgeax/engine-render';
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('${PACKAGE}'),
  build({ packageId }) {
    const serial = (globalThis.__capturedBuilds ?? 0) + 1;
    globalThis.__capturedBuilds = serial;
    const slot = 'paint' + serial;
    const m = model();
    m.box({ size: [1, 1, 1], tag: 'shell' });
    m.uv.project({ mode: 'box', scale: 1 });
    m.assign(sel.tag('shell'), slot);
    const out = m.finish({ key: 'crate' });
    if (!out.ok || ${withMaterials ? 'false' : 'true'}) return out;
    const green = textureFrom(4, 4, () => [0, 1, 0, 1], { colorSpace: 'srgb' });
    if (!green.ok) return green;
    const ref = AssetGuid.format(AssetGuid.derive(packageId, 'texture/green'));
    return {
      ok: true,
      value: {
        ...out.value,
        'texture/green': green.value,
        ['material/' + slot]: Materials.standard({ baseColor: [1, 1, 1, 1], baseColorTexture: ref }),
        'material/spare': Materials.standard({ baseColor: [1, 0, 0, 1] }),
      },
    };
  },
});
`;

beforeAll(async () => {
  directory = await mkdtemp(join(root, '.isolation-capture-materials-'));
  await writeFile(join(directory, 'painted.pack.ts'), PACK(true));
  await writeFile(join(directory, 'bare.pack.ts'), PACK(false));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('capture Pack materials', () => {
  it('a render carries material outputs by slot name and textures by GUID', {
    timeout: 60000,
  }, async () => {
    const response = await runCapture({
      sourcePath: join(directory, 'painted.pack.ts'),
      render: true,
    });
    if (!response.ok) throw new Error(response.error.code);
    const slots = response.value.render?.mesh.materialSlots.map((s) => s.slotName) ?? [];
    expect(slots).toEqual(['paint1']);
    const packed = response.value.materials;
    expect(Object.keys(packed?.materials ?? {}).sort()).toEqual(['paint1', 'spare']);
    expect(Object.keys(packed?.textures ?? {})).toEqual([guid('texture/green')]);
    expect(packed?.materials.paint1?.kind).toBe('material');
    expect(packed?.textures[guid('texture/green')]?.kind).toBe('texture');
    expect(JSON.stringify(packed?.materials.paint1)).toContain(guid('texture/green'));
  });

  it('comes from the build that produced the mesh, not from a timing rebuild', {
    timeout: 60000,
  }, async () => {
    const response = await runCapture({
      sourcePath: join(directory, 'painted.pack.ts'),
      render: true,
      timingRuns: {},
    });
    if (!response.ok) throw new Error(response.error.code);
    const slot = response.value.render?.mesh.materialSlots[0]?.slotName;
    expect(slot).toBe('paint1');
    expect(Object.keys(response.value.materials?.materials ?? {})).toContain(slot);
  });

  it('a replay carries the same field once, and a plain inspect carries none', {
    timeout: 60000,
  }, async () => {
    const replayed = await runCapture({
      sourcePath: join(directory, 'painted.pack.ts'),
      replay: 'all',
    });
    if (!replayed.ok) throw new Error(replayed.error.code);
    expect(Object.keys(replayed.value.materials?.materials ?? {})).toContain('paint1');
    const inspected = await runCapture({ sourcePath: join(directory, 'painted.pack.ts') });
    if (!inspected.ok) throw new Error(inspected.error.code);
    expect(inspected.value.materials).toBeUndefined();
  });

  it('a Pack without material outputs leaves the field absent', { timeout: 60000 }, async () => {
    const response = await runCapture({
      sourcePath: join(directory, 'bare.pack.ts'),
      render: true,
    });
    if (!response.ok) throw new Error(response.error.code);
    expect(response.value.materials).toBeUndefined();
  });
});
