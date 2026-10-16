import type { MaterialTextureCoordinates } from '@forgeax/engine-types';

/** The sole coordinate-record writer for direct UBOs and GPU Scene rows. */
export function writeMaterialTextureCoordinateRecord(
  target: Float32Array,
  offset: number,
  source: MaterialTextureCoordinates | undefined,
  physicalScale?: readonly [number, number],
): void {
  const transform = source?.transform;
  const physical = physicalScale ?? source?.physicalUvScale;
  const rotation = transform?.rotation ?? 0;
  target[offset] = transform?.offset?.[0] ?? 0;
  target[offset + 1] = transform?.offset?.[1] ?? 0;
  target[offset + 2] = transform?.scale?.[0] ?? 1;
  target[offset + 3] = transform?.scale?.[1] ?? 1;
  target[offset + 4] = source?.set ?? 0;
  target[offset + 5] = rotation;
  target[offset + 6] = physical?.[0] ?? 1;
  target[offset + 7] = physical?.[1] ?? 1;
  // Match the f32 angle historically consumed by WGSL before evaluating trig.
  const angle = Math.fround(rotation);
  target[offset + 8] = Math.cos(angle);
  target[offset + 9] = Math.sin(angle);
  target[offset + 10] = 0;
  target[offset + 11] = 0;
}
