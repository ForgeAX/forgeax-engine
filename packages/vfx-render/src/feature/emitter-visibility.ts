import { frustum } from '@forgeax/engine-math';
import type { VfxGpuTickIntent } from '@forgeax/engine-vfx';
import type { ParticleRenderCamera } from './camera.js';

/**
 * Each extract/plan invocation owns its scratch, including synchronous reentry.
 * Visibility is camera-dependent and therefore never cached across frames; the
 * frustum planes are derived once per distinct view-projection per invocation
 * instead of once per emitter test.
 */
export function createEmitterVisibility() {
  const worldCenter = new Float32Array(3);
  const cameras: {
    readonly viewProjection: Float32Array;
    readonly planes: ReturnType<typeof frustum.create>;
  }[] = [];
  const planesFor = (viewProjection: ParticleRenderCamera['viewProjection']) => {
    search: for (const row of cameras) {
      for (let index = 0; index < 16; index++)
        if (!Object.is(row.viewProjection[index], viewProjection[index] ?? 0)) continue search;
      return row.planes;
    }
    const planes = frustum.create();
    frustum.fromViewProjection(planes, viewProjection);
    const copy = new Float32Array(16);
    for (let index = 0; index < 16; index++) copy[index] = viewProjection[index] ?? 0;
    // A few views per frame; keep the scan bounded if a caller streams cameras.
    if (cameras.length >= 8) cameras.shift();
    cameras.push({ viewProjection: copy, planes });
    return planes;
  };
  return function emitterVisible(
    emitter: VfxGpuTickIntent['emitter'],
    camera: ParticleRenderCamera,
    localToWorld: Float32Array,
  ): boolean {
    const bounds = emitter.bounds;
    let cx: number;
    let cy: number;
    let cz: number;
    let radius: number;
    if (bounds.kind === 'sphere') {
      cx = bounds.center[0];
      cy = bounds.center[1];
      cz = bounds.center[2];
      radius = bounds.radius;
    } else {
      cx = (bounds.min[0] + bounds.max[0]) * 0.5;
      cy = (bounds.min[1] + bounds.max[1]) * 0.5;
      cz = (bounds.min[2] + bounds.max[2]) * 0.5;
      radius = Math.hypot(
        (bounds.max[0] - bounds.min[0]) * 0.5,
        (bounds.max[1] - bounds.min[1]) * 0.5,
        (bounds.max[2] - bounds.min[2]) * 0.5,
      );
    }
    const matrix = (index: number): number => localToWorld[index] ?? 0;
    worldCenter[0] = matrix(0) * cx + matrix(4) * cy + matrix(8) * cz + matrix(12);
    worldCenter[1] = matrix(1) * cx + matrix(5) * cy + matrix(9) * cz + matrix(13);
    worldCenter[2] = matrix(2) * cx + matrix(6) * cy + matrix(10) * cz + matrix(14);
    const scale = Math.max(
      Math.hypot(matrix(0), matrix(1), matrix(2)),
      Math.hypot(matrix(4), matrix(5), matrix(6)),
      Math.hypot(matrix(8), matrix(9), matrix(10)),
    );
    return frustum.intersectsSphere(planesFor(camera.viewProjection), worldCenter, radius * scale);
  };
}
