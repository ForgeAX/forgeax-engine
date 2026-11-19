import { createMeshBuilder } from '@forgeax/engine/geometry';

export const WATER_ENTRY_SURFACE_SEGMENTS = 64;

export function waterEntryCrownProfile(
  angle: number,
  t: number,
): readonly [number, number, number] {
  const ligament = ((1 + Math.sin(angle * 9 + 0.4)) * 0.5) ** 12;
  const folds = Math.sin(angle * 7 + 0.4) * 0.045 + Math.sin(angle * 11) * 0.025;
  const radius = 1 + 0.26 * t ** 1.7 + (folds + ligament * 0.055) * t ** 4;
  const height = t * (0.83 + 0.57 * ligament * t ** 7 + folds * t ** 3);
  return [Math.cos(angle) * radius, height, Math.sin(angle) * radius];
}

/** Sampled from the actual mesh rim, so release positions share its geometry authority. */
export function waterEntryCrownRimModule(): string {
  const rim = Array.from(
    { length: WATER_ENTRY_SURFACE_SEGMENTS + 1 },
    (_, segment) =>
      `vec3<f32>(${waterEntryCrownProfile((segment / WATER_ENTRY_SURFACE_SEGMENTS) * Math.PI * 2, 1)
        .map((value) => value.toFixed(8))
        .join(', ')})`,
  );
  return `#define_import_path water_entry::geometry
const ENTRY_RIM: array<vec3<f32>, ${rim.length}> = array<vec3<f32>, ${rim.length}>(${rim.join(',\n')});
fn entry_crown_rim(turn: f32) -> vec3<f32> {
  let index = fract(turn) * ${WATER_ENTRY_SURFACE_SEGMENTS}.0;
  let first = u32(floor(index));
  return mix(ENTRY_RIM[first], ENTRY_RIM[first + 1u], fract(index));
}`;
}

/** Unit surfaces; the cooked VFX program scales them from the native entry. */
export function waterEntrySurface(kind: 'crown' | 'tongue') {
  const positions: number[] = [];
  const uv: number[] = [];
  const indices: number[] = [];
  const segments = WATER_ENTRY_SURFACE_SEGMENTS;
  const rings = 9;
  // The tongue ends in one fan vertex; collapsing a duplicated ring leaves degenerate faces.
  for (let ring = 0; ring < rings; ring++) {
    const t = ring / (kind === 'tongue' ? rings : rings - 1);
    for (let segment = 0; segment <= segments; segment++) {
      const angle = (segment / segments) * Math.PI * 2;
      const lobes = Math.sin(angle * 7 + 0.4) * 0.07 + Math.sin(angle * 11) * 0.035;
      const radius = 0.52 * (1 - t) ** 1.35 * (1 + lobes * Math.sin(Math.PI * t));
      const bend = kind === 'tongue' ? 0.055 * t * t : 0;
      positions.push(
        ...(kind === 'crown'
          ? waterEntryCrownProfile(angle, t)
          : [Math.cos(angle) * radius + bend, t, Math.sin(angle) * radius]),
      );
      uv.push(segment / segments, t);
      if (ring < rings - 1 && segment < segments) {
        const first = ring * (segments + 1) + segment;
        const next = first + segments + 1;
        indices.push(first, next, first + 1, first + 1, next, next + 1);
      }
    }
  }
  if (kind === 'tongue') {
    const tip = positions.length / 3;
    positions.push(0.055, 1, 0);
    uv.push(0.5, 1);
    const lastRing = (rings - 1) * (segments + 1);
    for (let segment = 0; segment < segments; segment++)
      indices.push(lastRing + segment, tip, lastRing + segment + 1);
  }
  return createMeshBuilder({
    attributes: { position: new Float32Array(positions), uv: new Float32Array(uv) },
    indices,
  })
    .build()
    .unwrap();
}
