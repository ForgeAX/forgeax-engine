import { fileURLToPath } from 'node:url';
import { bakeMaps, createBakeCooker, MATERIAL_ID_PALETTE } from '@forgeax/engine-modeling';
import { executePackBuild } from '@forgeax/engine-pack/source';
import type { TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, recordingSessions } from '../../case/record';
import pack from '../armor.pack';
import { ARMOR_DEFAULTS, armorBake, buildArmor } from '../armor';

const SOURCE = fileURLToPath(new URL('../armor.ts', import.meta.url));
const SMALL = { ...ARMOR_DEFAULTS, resolution: 128 };

function info(diagnostics: readonly { severity: string; detail?: unknown }[] | undefined) {
  return diagnostics?.filter((d) => d.severity === 'info').at(-1)?.detail as {
    metrics: Record<string, number>;
    unwrap: Record<string, number>;
  };
}

describe('C-110 armor detail bake', () => {
  it('records straight-line history and auto-UVs the base without UV issues', { timeout: 120000 }, () => {
    const recording = recordingSessions();
    const armor = buildArmor(SMALL, recording.session);
    const steps = attachSourceLines(recording.steps, SOURCE);
    expect(steps.length).toBeGreaterThanOrEqual(20);
    expect(steps.every((s) => s.entry.status === 'ok')).toBe(true);
    const auto = steps.find((s) => s.entry.op === 'uv.auto');
    const d = info(auto?.entry.diagnostics);
    expect(d.metrics.charts).toBe(6);
    expect(d.unwrap.flipped).toBe(0);
    expect(d.unwrap.areaDistortion).toBeLessThan(1.1);
    const issues = armor.base.validate({ uniqueUv: true }).issues.map((i) => i.code);
    expect(issues.filter((c) => c.startsWith('uv-'))).toEqual([]);
  });

  it('bakes grooves, vents and bolts into the normal, AO and material-id maps; the base onto itself bakes none (falsifier)', { timeout: 120000 }, () => {
    const { base, bake } = buildArmor(SMALL);
    const self = bakeMaps({ base, detail: base, ...armorBake(SMALL) });
    if (!self.ok) throw self.error;
    const flat = self.value.textures.normal?.data as Uint8Array;
    const flatAo = self.value.textures.ao?.data as Uint8Array;
    for (let i = 0; i < 128 * 128; i++) {
      expect(flat[i * 4 + 2]).toBeGreaterThanOrEqual(250);
      expect(flatAo[i * 4]).toBeGreaterThanOrEqual(200);
    }
    expect(bake.report.metrics.rayHitRatio).toBeGreaterThan(0.99);
    expect(bake.provenance.materials.map((m) => m.slot)).toEqual(['paint', 'groove', 'vent', 'bolt']);
    const normal = bake.textures.normal?.data as Uint8Array;
    const ao = bake.textures.ao?.data as Uint8Array;
    const id = bake.textures.materialId?.data as Uint8Array;
    let tilted = 0;
    let occluded = 0;
    const colors = new Set<string>();
    for (let i = 0; i < 128 * 128; i++) {
      if ((normal[i * 4 + 2] as number) < 250) tilted++;
      if ((ao[i * 4] as number) < 200) occluded++;
      colors.add(Array.from(id.subarray(i * 4, i * 4 + 3)).join(','));
    }
    // Measured at 128 texels: 10 tilted (bolt flanks, seam ends) and 129 occluded texels.
    expect(tilted).toBeGreaterThanOrEqual(5);
    expect(occluded).toBeGreaterThan(50);
    const srgb = (c: number) => Math.round((c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255);
    for (const slot of [0, 1, 2, 3]) {
      expect(colors.has((MATERIAL_ID_PALETTE[slot] as readonly number[]).map(srgb).join(','))).toBe(true);
    }
  });

  it('the Pack defers the bake to the modeling-bake NativeCooker and keeps ordinary mesh outputs', { timeout: 120000 }, async () => {
    const built = await executePackBuild(pack, {
      packageId: pack.packageId,
      readByGuid: async () => {
        throw new Error('no reads expected');
      },
      values: { curl: 50, resolution: 64 },
    });
    if (!built.ok) throw built.error;
    const outputs = built.value as Record<string, { kind: string; execution?: string; source?: unknown }>;
    expect(Object.keys(outputs).sort()).toEqual([
      'material/armor-baked',
      'mesh/armor',
      'mesh/armor-detail',
      'texture/armor-ao',
      'texture/armor-materialId',
      'texture/armor-normal',
    ]);
    expect(outputs['texture/armor-normal']).toMatchObject({ kind: 'modeling-bake', execution: 'cooked' });
    const draft = await createBakeCooker().cook({
      guid: '01900000-0000-7000-8000-00000c011001',
      source: JSON.parse(JSON.stringify(outputs['texture/armor-ao']?.source)),
    });
    const texture = draft.payload as TextureAsset;
    expect(texture.kind).toBe('texture');
    expect(texture.shape.extent).toEqual({ width: 64, height: 64 });
    expect(texture.mips).toMatchObject({ kind: 'packed' });
  });
});
