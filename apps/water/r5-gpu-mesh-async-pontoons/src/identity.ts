import { PackageId } from '@forgeax/engine/pack/guid';

const packageId = PackageId.parse('f05e8f4a-16b4-4a61-a611-114016aaf005');
if (!packageId.ok) throw packageId.error;
export const WATER_R5_PACKAGE = packageId.value;
export type Craft = 'river' | 'lake' | 'ocean';
export type PontoonCount = 1 | 4 | 16;
export const CRAFTS = ['river', 'lake', 'ocean'] as const;
export const CRAFT_LABELS = { river: '河道 · 赤潮号', lake: '湖面 · 银湾号', ocean: '近海 · 远望号' } as const;
export const START_POSITIONS = { river: [-48, .7, -9], lake: [-5, .7, 3], ocean: [37, .7, -4] } as const;
export function pontoonLayout(count: PontoonCount): readonly (readonly [number, number, number])[] {
  if (count === 1) return [[0, .15, 0]];
  const side = count === 4 ? 2 : 4, points: [number, number, number][] = [];
  for (let x = 0; x < side; x++) for (let z = 0; z < side; z++) points.push([-1.5 + x * 3 / (side - 1), .15, -.78 + z * 1.56 / (side - 1)]);
  return points;
}
