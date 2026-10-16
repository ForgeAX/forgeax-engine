import { createRevolutionGeometry } from '@forgeax/engine/geometry';
import { AssetGuid } from '@forgeax/engine/pack/source';

/** Executed by RuntimePackProducer after admission; no mesh variant is prebuilt. */
export function build({ values }) {
  const { height, radius, sides } = values;
  const profile = [[0, 0], [0.55, 0], [0.65, 0.08], [1, 0.35],
    [0.9, 0.58], [0.4, 0.82], [0.42, 0.96], [0.55, 1],
    [0.47, 1], [0.34, 0.95], [0.32, 0.82], [0.82, 0.58],
    [0.9, 0.35], [0.55, 0.12], [0, 0.12]];
  const material = AssetGuid.parse(values.material);
  if (!material.ok) return material;
  const mesh = createRevolutionGeometry(profile.map(([x, y]) => ({ x: x * radius, y: y * height })), sides).unwrap();
  return { ok: true, value: { vase: { ...mesh,
    materialSlots: [{ slotName: 'surface', sourceKey: 'game-3d:vase', defaultMaterial: material.value }],
  } } };
}
