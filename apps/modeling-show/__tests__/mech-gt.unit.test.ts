import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { MECH_GT_SUBJECTS } from '../assets/show/mech-gt.ts';
import { discoverOutputs, packGuid } from '../assets/show/subjects.ts';

const ASSETS = resolve(import.meta.dirname, '../mech-gt/assets');

/** Every Pack output the mech-gt program loads exists in its sibling Pack's build. */
it('the mech-gt program names only outputs its Packs publish', { timeout: 300_000 }, async () => {
  const packs = new Map<
    string,
    { packageId: Uint8Array; build: (context: unknown) => unknown; parameters?: readonly { name: string; default: unknown }[] }
  >();
  for (const file of readdirSync(ASSETS).filter((f) => f.endsWith('.pack.ts') && f !== 'show.pack.ts')) {
    const pack = (await import(resolve(ASSETS, file))).default;
    packs.set(Buffer.from(pack.packageId).toString('hex'), pack);
  }
  for (const subject of MECH_GT_SUBJECTS) {
    for (const source of subject.packs) {
      const pack = packs.get(source.packageId.replaceAll('-', ''));
      expect(pack, `a sibling Pack with packageId ${source.packageId}`).toBeDefined();
      const values = Object.fromEntries((pack?.parameters ?? []).map((p) => [p.name, p.default]));
      const built = (await pack?.build({ packageId: pack?.packageId, values })) as { ok: boolean; value: Record<string, unknown> };
      expect(built.ok).toBe(true);
      const keys = [...(source.scenes ?? []), ...(source.meshes ?? []), ...Object.values(source.materials ?? {})];
      expect(keys.filter((key) => !(key in built.value)), `${subject.name}: ${source.packageId}`).toEqual([]);
    }
  }
});

/**
 * The transform subject shows only what `scene/s7` animates: its material-only Packs (front, nose,
 * wheels, internals, cabin, robot) must not be discovered into static meshes, or the finished car
 * groups and the S6b robot body float beside the clip (user report, F1-BUG-LEFTOVER).
 */
it('the transform subject adds no static mesh beside the S7 scene, whatever its Packs publish', () => {
  const transform = MECH_GT_SUBJECTS.find((s) => s.name === 'transform');
  expect(transform).toBeDefined();
  const entries = (transform?.packs ?? []).flatMap((pack) => [
    { guid: packGuid(pack.packageId, 'mesh/published'), kind: 'mesh', sourceKey: 'mesh/published' },
  ]);
  const [found] = discoverOutputs(transform ? [transform] : [], entries);
  const meshes = (found?.packs ?? []).flatMap((pack) => (pack.meshes ?? []).map((key) => `${pack.packageId}:${key}`));
  expect(meshes).toEqual([]);
  expect((found?.packs ?? []).filter((pack) => pack.scenes?.length).map((pack) => pack.scenes)).toEqual([['scene/s7']]);
});
