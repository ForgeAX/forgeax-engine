import { describe, expect, it } from 'vitest';
import {
  cameraDistanceScale,
  cameraPose,
  characterPositions,
  debrisChunks,
  GROUND_HALF_EXTENT,
  LOD_GRID_SIDE,
  LOD_SCREEN_COVERAGE,
  LOD_SPHERE_RADIUS,
  lodGridPositions,
  OCCASIONAL_PERIOD_FRAMES,
  occasionalPositions,
  occasionalPushFrame,
  MOVER_COUNT_MAX,
  parseWorkloadOptions,
  SPAWN_STORM_COUNT_MAX,
  spawnStormPositions,
  STATIC_CHUNK_SIZE,
  staticCasterChunks,
  workloadFingerprint,
  writeMoverTransforms,
} from '../workload';

describe('shadow stress workload', () => {
  it('parses defaults and explicit scale parameters', () => {
    const defaults = parseWorkloadOptions(new URLSearchParams());
    expect(defaults).toEqual({
      ok: true,
      value: { staticCasterCount: 4000, moverCount: 128, activeMoverCount: 128, moverWrite: 'rows', characterCount: 4, debrisCount: 0, pointCount: 0, camera: 'static', capsuleShadow: false, renderPath: 'forward', gpuOcclusion: true, occasionalCount: 0, occasionalPeriod: 300, spawnStormCount: 0, lodOscillate: false, transparentCount: 0, taa: false, mobilityStatic: false, lodGridSide: 0, gpuPassTiming: false },
    });
    const explicit = parseWorkloadOptions(
      new URLSearchParams('statics=1200&movers=0&activeMovers=0&moverWrite=set&characters=2&debris=900&points=2&camera=orbit&capsuleShadow=1&renderPath=deferred&gpuOcclusion=0&occasional=64&occasionalPeriod=150&spawnStorm=8&lodOscillate=1&transparent=256&taa=1&mobilityStatic=1'),
    );
    expect(explicit).toEqual({
      ok: true,
      value: { staticCasterCount: 1200, moverCount: 0, activeMoverCount: 0, moverWrite: 'set', characterCount: 2, debrisCount: 900, pointCount: 2, camera: 'orbit', capsuleShadow: true, renderPath: 'deferred', gpuOcclusion: false, occasionalCount: 64, occasionalPeriod: 150, spawnStormCount: 8, lodOscillate: true, transparentCount: 256, taa: true, mobilityStatic: true, lodGridSide: LOD_GRID_SIDE, gpuPassTiming: false },
    });
  });

  it('rejects out-of-range counts and unknown camera modes without clamping', () => {
    const count = parseWorkloadOptions(new URLSearchParams(`movers=${MOVER_COUNT_MAX + 1}`));
    expect(count.ok).toBe(false);
    if (!count.ok) {
      expect(count.error.code).toBe('workload-count-out-of-range');
      expect(count.error.detail).toEqual({ parameter: 'movers', value: String(MOVER_COUNT_MAX + 1) });
    }
    expect(parseWorkloadOptions(new URLSearchParams('statics=0')).ok).toBe(false);
    const camera = parseWorkloadOptions(new URLSearchParams('camera=fly'));
    expect(camera.ok).toBe(false);
    if (!camera.ok) expect(camera.error).toMatchObject({ code: 'workload-camera-invalid', detail: { value: 'fly' } });
    const capsule = parseWorkloadOptions(new URLSearchParams('capsuleShadow=yes'));
    expect(capsule.ok).toBe(false);
    if (!capsule.ok) expect(capsule.error).toMatchObject({ code: 'workload-capsule-shadow-invalid' });
    const path = parseWorkloadOptions(new URLSearchParams('renderPath=hybrid'));
    expect(path.ok).toBe(false);
    if (!path.ok) expect(path.error).toMatchObject({ code: 'workload-render-path-invalid' });
    const occlusion = parseWorkloadOptions(new URLSearchParams('gpuOcclusion=off'));
    expect(occlusion.ok).toBe(false);
    if (!occlusion.ok) expect(occlusion.error).toMatchObject({ code: 'workload-gpu-occlusion-invalid', detail: { value: 'off' } });
    const storm = parseWorkloadOptions(new URLSearchParams(`spawnStorm=${SPAWN_STORM_COUNT_MAX + 1}`));
    expect(storm.ok).toBe(false);
    if (!storm.ok) expect(storm.error.detail).toEqual({ parameter: 'spawnStorm', value: String(SPAWN_STORM_COUNT_MAX + 1) });
    expect(parseWorkloadOptions(new URLSearchParams('occasional=-1')).ok).toBe(false);
    const lod = parseWorkloadOptions(new URLSearchParams('lodOscillate=yes'));
    expect(lod.ok).toBe(false);
    if (!lod.ok) expect(lod.error).toMatchObject({ code: 'workload-lod-oscillate-invalid', detail: { value: 'yes' } });
    const active = parseWorkloadOptions(new URLSearchParams('movers=64&activeMovers=65'));
    expect(active.ok).toBe(false);
    if (!active.ok) expect(active.error.detail).toEqual({ parameter: 'activeMovers', value: '65' });
    const write = parseWorkloadOptions(new URLSearchParams('moverWrite=patch'));
    expect(write.ok).toBe(false);
    if (!write.ok) expect(write.error).toMatchObject({ code: 'workload-mover-write-invalid', detail: { value: 'patch' } });
    expect(parseWorkloadOptions(new URLSearchParams('transparent=1025')).ok).toBe(false);
    const taa = parseWorkloadOptions(new URLSearchParams('taa=on'));
    expect(taa.ok).toBe(false);
    if (!taa.ok) expect(taa.error).toMatchObject({ code: 'workload-taa-invalid', detail: { value: 'on' } });
    const mobility = parseWorkloadOptions(new URLSearchParams('mobilityStatic=yes'));
    expect(mobility.ok).toBe(false);
    if (!mobility.ok) expect(mobility.error).toMatchObject({ code: 'workload-mobility-static-invalid', detail: { value: 'yes' } });
  });

  it('builds deterministic static chunks with the exact caster count', () => {
    const options = {
      staticCasterCount: STATIC_CHUNK_SIZE * 2 + 7,
      moverCount: 0,
      activeMoverCount: 0,
      moverWrite: 'rows' as const,
      characterCount: 0,
      debrisCount: STATIC_CHUNK_SIZE + 3,
      pointCount: 0,
      camera: 'static' as const,
      capsuleShadow: false,
      renderPath: 'forward' as const,
      gpuOcclusion: true,
      occasionalCount: 0,
      occasionalPeriod: OCCASIONAL_PERIOD_FRAMES,
      spawnStormCount: 0,
      lodOscillate: false,
      transparentCount: 0,
      taa: false,
      mobilityStatic: false,
      lodGridSide: 0,
      gpuPassTiming: false,
    };
    const debris = debrisChunks(options);
    expect(debris.map((chunk) => chunk.length / 16)).toEqual([STATIC_CHUNK_SIZE, 3]);
    expect(debris.every((chunk) => chunk.every((value) => Math.abs(value) < GROUND_HALF_EXTENT))).toBe(true);
    const first = staticCasterChunks(options);
    const second = staticCasterChunks(options);
    expect(first.map((chunk) => chunk.length / 16)).toEqual([STATIC_CHUNK_SIZE, STATIC_CHUNK_SIZE, 7]);
    expect(first).toEqual(second);
    for (const chunk of first) {
      for (let row = 0; row < chunk.length / 16; row++) {
        expect(chunk[row * 16 + 15]).toBe(1);
        expect(chunk[row * 16 + 13]).toBeGreaterThan(0);
      }
    }
  });

  it('moves the dynamic instances between simulation times', () => {
    const start = new Float32Array(4 * 16);
    const later = new Float32Array(4 * 16);
    writeMoverTransforms(start, 4, 0);
    writeMoverTransforms(later, 4, 0.5);
    expect(start).not.toEqual(later);
    expect(start[15]).toBe(1);
    const partial = new Float32Array(start);
    writeMoverTransforms(partial, 4, 0.5, 1);
    expect(partial.subarray(0, 16)).toEqual(later.subarray(0, 16));
    expect(partial.subarray(16)).toEqual(start.subarray(16));
  });

  it('places characters and aims the camera at the origin', () => {
    expect(characterPositions(2)).toHaveLength(6);
    const staticPose = cameraPose('static', 10);
    expect(staticPose).toEqual(cameraPose('static', 0));
    expect(cameraPose('orbit', 10).pos).not.toEqual(staticPose.pos);
    const low = cameraPose('low', 3);
    expect(low.pos[1]).toBe(1.5);
    expect(Math.hypot(low.pos[0], low.pos[2])).toBeCloseTo(56);
    expect(low.pos).not.toEqual(cameraPose('low', 0).pos);
  });

  it('parses the occlusion A/B knobs and rejects malformed values', () => {
    const parsed = parseWorkloadOptions(new URLSearchParams('camera=low&lodGrid=40&gpuTiming=1'));
    if (!parsed.ok) throw new Error('occlusion knobs must parse');
    expect(parsed.value).toMatchObject({ camera: 'low', lodGridSide: 40, gpuPassTiming: true });
    expect(lodGridPositions(40)).toHaveLength(40 * 40 * 3);
    expect(workloadFingerprint(parsed.value)).toContain('|camera=low|');
    expect(workloadFingerprint(parsed.value)).toContain('|lodGrid=40');
    const oscillate = parseWorkloadOptions(new URLSearchParams('lodOscillate=1'));
    expect(oscillate.ok && oscillate.value.lodGridSide).toBe(LOD_GRID_SIDE);
    expect(oscillate.ok && workloadFingerprint(oscillate.value)).not.toContain('lodGrid=');
    const badGrid = parseWorkloadOptions(new URLSearchParams('lodGrid=65'));
    expect(!badGrid.ok && badGrid.error.code).toBe('workload-count-out-of-range');
    const badTiming = parseWorkloadOptions(new URLSearchParams('gpuTiming=yes'));
    expect(!badTiming.ok && badTiming.error.code).toBe('workload-gpu-timing-invalid');
  });

  it('pushes each occasional caster exactly once per period, staggered', () => {
    const count = 128;
    expect(occasionalPositions(count)).toHaveLength(count * 3);
    const perFrame = new Array<number>(OCCASIONAL_PERIOD_FRAMES).fill(0);
    for (let index = 0; index < count; index++) {
      const frame = occasionalPushFrame(index, count);
      expect(frame).toBeGreaterThanOrEqual(0);
      expect(frame).toBeLessThan(OCCASIONAL_PERIOD_FRAMES);
      perFrame[frame] = (perFrame[frame] ?? 0) + 1;
    }
    expect(Math.max(...perFrame)).toBe(1);
  });

  it('gives every storm frame a fresh deterministic caster set', () => {
    expect(spawnStormPositions(4, 3)).toEqual(spawnStormPositions(4, 3));
    expect(spawnStormPositions(4, 3)).not.toEqual(spawnStormPositions(4, 4));
    expect(spawnStormPositions(4, 3).every((value) => Math.abs(value) < GROUND_HALF_EXTENT)).toBe(true);
  });

  it('oscillates the camera across both LOD thresholds only when requested', () => {
    expect(cameraDistanceScale(false, 0.7)).toBe(1);
    expect(cameraPose('static', 0.7)).toEqual(cameraPose('static', 0));
    expect(lodGridPositions()).toHaveLength(LOD_GRID_SIDE * LOD_GRID_SIDE * 3);
    const baseDistance = Math.hypot(34, 18);
    const radius = Math.sqrt(3) * LOD_SPHERE_RADIUS;
    const height = (scale: number) => (2 * radius) / (baseDistance * scale * Math.tan(Math.PI / 6));
    let near = Number.POSITIVE_INFINITY;
    let far = 0;
    for (let frame = 0; frame < 120; frame++) {
      const scale = cameraDistanceScale(true, frame / 60);
      near = Math.min(near, scale);
      far = Math.max(far, scale);
    }
    expect(height(near)).toBeGreaterThan(LOD_SCREEN_COVERAGE[0]);
    expect(height(far)).toBeLessThan(LOD_SCREEN_COVERAGE[1]);
    expect(cameraPose('static', 0.5, true).pos).not.toEqual(cameraPose('static', 0, true).pos);
  });

  it('fingerprints the workload identity', () => {
    const defaults = parseWorkloadOptions(new URLSearchParams());
    if (!defaults.ok) throw new Error('defaults must parse');
    expect(workloadFingerprint(defaults.value)).toMatch(/^perf-shadow-stress\/v1\|.*\|hash=[0-9a-f]{8}$/u);
    expect(workloadFingerprint(defaults.value)).not.toContain('capsuleShadow');
    expect(workloadFingerprint({ ...defaults.value, capsuleShadow: true })).toContain('|capsuleShadow=1|');
    expect(workloadFingerprint({ ...defaults.value, renderPath: 'deferred' })).toContain('|renderPath=deferred|');
    expect(workloadFingerprint({ ...defaults.value, gpuOcclusion: false })).toContain('|gpuOcclusion=0|');
    expect(workloadFingerprint(defaults.value)).not.toMatch(/occasional|spawnStorm|lodOscillate|taa/u);
    expect(workloadFingerprint({ ...defaults.value, occasionalCount: 8 })).toContain('|occasional=8|');
    expect(
      workloadFingerprint({ ...defaults.value, occasionalCount: 8, occasionalPeriod: 150 }),
    ).toContain('|occasional=8|occasionalPeriod=150|');
    expect(workloadFingerprint({ ...defaults.value, spawnStormCount: 8 })).toContain('|spawnStorm=8|');
    expect(workloadFingerprint({ ...defaults.value, lodOscillate: true })).toContain('|lodOscillate=1|');
    expect(workloadFingerprint(defaults.value)).not.toMatch(/activeMovers|moverWrite/u);
    expect(workloadFingerprint({ ...defaults.value, activeMoverCount: 1 })).toContain('|movers=128|activeMovers=1|');
    expect(workloadFingerprint({ ...defaults.value, moverWrite: 'set' })).toContain('|moverWrite=set|');
    expect(workloadFingerprint(defaults.value)).not.toMatch(/transparent|taa/u);
    expect(workloadFingerprint({ ...defaults.value, transparentCount: 64 })).toContain('|transparent=64|');
    expect(workloadFingerprint({ ...defaults.value, taa: true })).toContain('|taa=1|');
    expect(workloadFingerprint(defaults.value)).not.toMatch(/mobilityStatic/u);
    expect(workloadFingerprint({ ...defaults.value, mobilityStatic: true })).toContain('|mobilityStatic=1|');
  });
});
