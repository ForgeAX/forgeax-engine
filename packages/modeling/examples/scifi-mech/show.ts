import { GROUPS } from './mech.ts';
import stats from './show.stats.json' with { type: 'json' };
import { partsOf } from './pipeline.ts';
import { HIGH_KEY, lowKey, SET_MAPS, SHOW, textureKey } from './show-job.ts';

/**
 * C-410 page metadata: plain data the 3D showcase page reads next to the Pack
 * (`scifi-mech.pack.ts`). Texture and mesh values are Pack output keys. `stats` are measured
 * by the full cook: `show.stats.json` is written from the cooked outputs by
 * scifi-mech.show.integration.test.ts (FORGEAX_UPDATE_GOLDEN=1) and that test checks it on every run.
 */
export interface ShowChannel {
  readonly c: 'r' | 'g' | 'b' | 'a';
  readonly label: string;
}
export interface ShowSlot {
  /** The mesh material slot (the texture set the part's UVs pack into). */
  readonly slot: string;
  readonly maps: { readonly normal?: string; readonly albedo?: string; readonly orm?: string; readonly emissive?: string };
  readonly channels: Readonly<Record<string, readonly ShowChannel[]>>;
  /** The baked material of this slot (maps on); `material/c410-plain` has no maps. */
  readonly material: string;
}
export interface ShowMeta {
  readonly id: 'C-410';
  readonly title: string;
  /** Part names: `lowMesh(part)` is the form mesh of each. */
  readonly parts: readonly string[];
  readonly meshes: { readonly low: string; readonly high: string; readonly plainMaterial: string };
  readonly slots: readonly ShowSlot[];
  readonly checker: { readonly texelsPerMeter: number };
  readonly stats: { readonly highTris: number; readonly highPreviewTris: number; readonly lowTris: number; readonly textureBytes: number };
}

export const lowMesh = (part: string) => lowKey(part);

export const SHOW_META: ShowMeta = {
  id: 'C-410',
  title: 'Warden: a 3.5 m heavy bipedal mech, high-to-low bake',
  parts: GROUPS.flatMap(partsOf),
  meshes: { low: `mesh/${SHOW.key}-low.<part>`, high: HIGH_KEY, plainMaterial: `material/${SHOW.key}-plain` },
  slots: SHOW.sets.map((set) => ({
    slot: set,
    maps: Object.fromEntries(SET_MAPS.map((m) => [m, textureKey(set, m)])),
    channels: {
      orm: [{ c: 'r', label: 'AO' }, { c: 'g', label: 'roughness' }, { c: 'b', label: 'metal' }],
      normal: [{ c: 'r', label: 'tangent x' }, { c: 'g', label: 'tangent y' }, { c: 'b', label: 'tangent z' }],
    },
    material: `material/${SHOW.key}-baked-${set}`,
  })),
  checker: { texelsPerMeter: 395 },
  stats: { highTris: stats.highTris, highPreviewTris: stats.highPreviewTris, lowTris: stats.lowTris, textureBytes: stats.textureBytes },
};
