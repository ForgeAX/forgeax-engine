import type { BakeSlot } from '@forgeax/engine/modeling';

export const CONVOY_SURFACE_IDS = { painted: [1, 0, 0], metal: [0, 1, 0], glass: [0, 0, 1], rubber: [1, 1, 0], other: [0, 0, 0] } as const;
const surface = <const T extends BakeSlot>(family: keyof typeof CONVOY_SURFACE_IDS, values: T) => ({ ...values, materialId: CONVOY_SURFACE_IDS[family] });

export const CONVOY_SURFACES = {
  red: surface('painted', { baseColor: [0.8, 0.055, 0.045, 1], metallic: 0.08, roughness: 0.22 }),
  blue: surface('painted', { baseColor: [0.055, 0.24, 0.63, 1], metallic: 0.08, roughness: 0.24 }),
  steel: surface('metal', { baseColor: [0.8, 0.85, 0.9, 1], metallic: 1, roughness: 0.18 }),
  dark: surface('metal', { baseColor: [0.045, 0.06, 0.085, 1], metallic: 1, roughness: 0.39 }),
  rubber: surface('rubber', { baseColor: [0.028, 0.032, 0.038, 1], metallic: 0, roughness: 0.86 }),
  gold: surface('metal', { baseColor: [0.82, 0.49, 0.16, 1], metallic: 0.85, roughness: 0.35 }),
  ink: surface('other', { baseColor: [0.88, 0.9, 0.83, 1], metallic: 0, roughness: 0.65 }),
  glass: surface('glass', { baseColor: [0.055, 0.27, 0.38, 1], metallic: 0, roughness: 0.06 }),
  cyan: surface('other', { baseColor: [0.08, 0.55, 0.8, 1], metallic: 0.25, roughness: 0.2, emissive: [0.08, 0.65, 1], emissiveIntensity: 2 }),
  amber: surface('other', { baseColor: [1, 0.4, 0.04, 1], metallic: 0.2, roughness: 0.3, emissive: [1, 0.28, 0.015], emissiveIntensity: 2 }),
} satisfies Readonly<Record<string, BakeSlot>>;

export const CONVOY_HARDWARE_SLOTS = ['steel', 'dark', 'gold', 'rubber'] as const;
