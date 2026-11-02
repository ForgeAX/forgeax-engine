import { type AssetsJob, type FaceSelector, type Model, model, sel } from '@forgeax/engine-modeling';
import { AssetGuid } from '@forgeax/engine-pack/source';
import { Materials } from '@forgeax/engine-render';
import { type Asset, type MeshAsset, ok, type TextureAsset } from '@forgeax/engine-types';
import { applyEmblem, applyFaceDecal } from './decals.ts';
import { buildFaceted } from './faceting.ts';
import { hairFaces, hairOmbre, skinSlots, slotColours, tailSlots } from './materials.ts';
import outputs from './g7-face.outputs.json' with { type: 'json' };

/** Key of the whole figure (`mesh/<key>`); each body part is `mesh/<key>.<part>`. */
export const G7_KEY = 'maid-whale-g7';

const tags = (...names: string[]): FaceSelector => names.reduce<FaceSelector>((s, t) => s.or(sel.tag(t)), sel.tag('__none__'));

/**
 * Body parts as a partition of the faces, in claim order (an earlier part keeps the faces a
 * later tag also names: the attachments sit inside the head, hair and dress tags).
 */
export const G7_PARTS: readonly { readonly name: string; readonly faces: () => FaceSelector }[] = [
  { name: 'headdress', faces: () => tags('headdress', 'headdress-band', 'headdress-teeth') },
  { name: 'ribbon-l', faces: () => tags('ribbon-l') },
  { name: 'ribbon-r', faces: () => tags('ribbon-r') },
  { name: 'fin-l', faces: () => tags('fin-l') },
  { name: 'fin-r', faces: () => tags('fin-r') },
  { name: 'back-bow', faces: () => tags('back-bow', 'back-bow-tie-a', 'back-bow-tie-b') },
  { name: 'bowtie', faces: () => tags('bowtie') },
  { name: 'brooch', faces: () => tags('brooch') },
  { name: 'hair', faces: () => hairFaces().or(tags('hair-fringe', 'hair-spike')) },
  { name: 'head', faces: () => tags('head', 'face-plane') },
  { name: 'tail', faces: () => tags('tail', 'fluke') },
  { name: 'apron', faces: () => tags('apron', 'apron-ruffle', 'apron-bib', 'apron-frill-l', 'apron-frill-r', 'apron-ties') },
  { name: 'skirt', faces: () => tags('skirt', 'skirt-hem', 'skirt-pleat', 'waistband') },
  { name: 'bodice', faces: () => tags('top', 'bodice', 'collar', 'trim-band', 'sleeve-l', 'sleeve-r', 'puff-l', 'puff-r', 'cuff-l', 'cuff-r') },
  { name: 'shoe-l', faces: () => tags('shoe-l', 'sock-l') },
  { name: 'shoe-r', faces: () => tags('shoe-r', 'sock-r') },
  { name: 'arm-l', faces: () => tags('arm-l', 'hand-l') },
  { name: 'arm-r', faces: () => tags('arm-r', 'hand-r') },
  { name: 'leg-l', faces: () => tags('leg-l') },
  { name: 'leg-r', faces: () => tags('leg-r') },
  { name: 'torso', faces: () => tags('torso') },
];

/** The faces no named part claims (kept as the part `rest`, never dropped). */
const REST = 'rest';

const PBR: Readonly<Record<string, { metallic: number; roughness: number }>> = {
  gold: { metallic: 0.9, roughness: 0.35 },
  gem: { metallic: 0, roughness: 0.15 },
  skin: { metallic: 0, roughness: 0.6 },
  'leg-skin': { metallic: 0, roughness: 0.6 },
  'hand-skin': { metallic: 0, roughness: 0.6 },
  shoe: { metallic: 0, roughness: 0.5 },
  ribbon: { metallic: 0, roughness: 0.55 },
};

/** Metallic/roughness of a plain slot's Standard material (hair buckets 0.55, others 0.7). */
export const slotPbr = (slot: string): { metallic: number; roughness: number } => PBR[slot] ?? { metallic: 0, roughness: slot.startsWith('hair') ? 0.55 : 0.7 };

/** The G6 figure with the G7 layer (hair ombre, tail and leg/hand skin slots, face and emblem decals) and its decal recipes. */
export function buildG7(): { readonly m: Model; readonly decals: ReturnType<typeof applyFaceDecal>[] } {
  const m = buildFaceted();
  hairOmbre(m);
  tailSlots(m);
  skinSlots(m);
  const decals = [applyFaceDecal(m, { mips: true }), applyEmblem(m, { mips: true })];
  return { m, decals };
}

function partMesh(snapshot: Uint8Array, name: string, claimed: FaceSelector, part: FaceSelector): Model | undefined {
  const p = model();
  p.append(snapshot);
  const keep = name === REST ? sel.all().minus(claimed) : part.minus(claimed);
  if (p.count(keep) === 0) return undefined;
  p.delete(sel.all().minus(keep));
  return p;
}

/**
 * C-200 G7 as an assets job: `mesh/maid-whale-g7` (whole figure) and `mesh/maid-whale-g7.<part>`
 * per body part (G7_PARTS plus `rest`), one Standard material per slot (`material/<slot>`:
 * palette, hair-0..5 ombre, tail and leg/hand skin slots, face and apron-front decals) and the decal textures
 * (`texture/maid-whale-face`, `texture/maid-whale-apron-emblem`, mipmapped). The faceting takes
 * about 90 s: the Pack publishes these outputs as cook sources; register
 * `createMeshJobCooker([G7_JOB])` in the project's build plugin.
 */
export const G7_JOB: AssetsJob<Record<string, never>> = {
  kind: 'assets',
  name: 'maid-whale.g7-face',
  build: (_params, { packageId }) => {
    const guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));
    const { m, decals } = buildG7();
    const slots = m.inspect().materials;
    const out: Record<string, Asset> = {};
    const snapshot = m.snapshot();
    const whole = m.finish({ key: G7_KEY, normals: { mode: 'weighted' } });
    if (!whole.ok) return whole;
    Object.assign(out, whole.value);
    let claimed: FaceSelector = sel.tag('__none__');
    for (const part of [...G7_PARTS, { name: REST, faces: () => sel.tag('__none__') }]) {
      const p = partMesh(snapshot, part.name, claimed, part.faces());
      if (p === undefined) continue;
      const done = p.finish({ key: `${G7_KEY}.${part.name}`, normals: { mode: 'weighted' } });
      if (!done.ok) return done;
      Object.assign(out, done.value as Record<string, MeshAsset>);
      if (part.name !== REST) claimed = claimed.or(part.faces());
    }
    const texture = (name: string, asset: TextureAsset) => {
      out[`texture/${name}`] = asset;
      return guid(`texture/${name}`);
    };
    const colours = slotColours();
    const recipes = Object.fromEntries(decals.map((d) => [d.slot, d.material]));
    for (const slot of slots) {
      // Output keys are lowercase: the unassigned `Default` slot is skipped when no face uses it.
      if (slot !== slot.toLowerCase() && m.count(sel.material(slot)) === 0) continue;
      const decal = recipes[slot];
      if (decal !== undefined) {
        out[`material/${slot}`] = Materials.standard(decal(texture));
        continue;
      }
      const c = colours[slot] ?? colours.Default;
      const pbr = slotPbr(slot);
      out[`material/${slot}`] = Materials.standard({ baseColor: [c?.[0] ?? 1, c?.[1] ?? 1, c?.[2] ?? 1, 1], ...pbr });
    }
    return ok(out);
  },
};

/** Output keys of the job (regenerated by the g7-face import test with FORGEAX_UPDATE_GOLDEN=1). */
export const G7_OUTPUTS: readonly string[] = outputs;
