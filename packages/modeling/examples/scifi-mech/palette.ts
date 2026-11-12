import type { BakeSlot } from '@forgeax/engine-modeling';

/** Physically based values of the eight bake classes (linear color): orange paint over gunmetal. */
export const PBR: Record<string, { color: [number, number, number]; metallic: number; roughness: number; emissive?: [number, number, number]; ei?: number }> = {
  armor: { color: [0.48, 0.13, 0.018], metallic: 0.05, roughness: 0.5 },
  accent: { color: [0.06, 0.064, 0.07], metallic: 0.6, roughness: 0.45 },
  frame: { color: [0.035, 0.037, 0.04], metallic: 0.8, roughness: 0.45 },
  steel: { color: [0.55, 0.55, 0.57], metallic: 1, roughness: 0.3 },
  rubber: { color: [0.018, 0.018, 0.02], metallic: 0, roughness: 0.75 },
  glow: { color: [0.1, 0.6, 0.85], metallic: 0, roughness: 0.3, emissive: [0.15, 0.75, 1], ei: 3.5 },
  hazard: { color: [0.8, 0.5, 0.015], metallic: 0.05, roughness: 0.5 },
  dark: { color: [0.012, 0.012, 0.014], metallic: 0, roughness: 0.7 },
};

const encode = (c: number) => Math.max(0, Math.min(1, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
/** The bake classes as kernel slots: the bake writes base color, ORM and emissive directly from these. */
export const SLOTS: Record<string, BakeSlot> = Object.fromEntries(
  Object.entries(PBR).map(([slot, p]) => [
    slot,
    { baseColor: [encode(p.color[0]), encode(p.color[1]), encode(p.color[2]), 1], roughness: p.roughness, metallic: p.metallic, ...(p.emissive ? { emissive: p.emissive, emissiveIntensity: p.ei ?? 1 } : {}) },
  ]),
);
/** The baked emissive map's scale (the kernel's `provenance.emissiveScale`): a material's emissive intensity. */
export const EMISSIVE_SCALE = Math.max(1, ...Object.values(PBR).flatMap((p) => (p.emissive ?? [0]).map((e) => e * (p.ei ?? 1))));
