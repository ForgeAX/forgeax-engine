import { describe, expect, it } from 'vitest';
import { shadowCameraCullDilation } from '../gpu-driven/shadow-views';
import {
  runGpuDrivenInactiveBatchEvidence,
  runGpuDrivenShadowCameraCullEvidence,
  runGpuDrivenSkinVisibleAddressEvidence,
  runGpuDrivenViewGpuEvidence,
  runGpuDrivenViewLifecycleEvidence,
  runGpuDrivenViewOcclusionEvidence,
} from './gpu-driven-view-gpu-evidence';

describe('GPU-driven View Dawn', () => {
  it('keeps true Skin source slot independent of visible instance and candidate identity', async () => {
    const result = await runGpuDrivenSkinVisibleAddressEvidence();
    expect(result, `actual skin visible addresses ${JSON.stringify(result)}`).toEqual({
      visibleInstance: 0,
      candidateIndex: 2,
      sourceSlot: 1,
      primitiveIndex: 0,
    });
  });

  it('disables and restores a material batch without rewriting candidate ranges', async () => {
    const frames = await runGpuDrivenInactiveBatchEvidence();
    expect(frames.map((frame) => frame.instances)).toEqual([
      [1, 1],
      [0, 1],
      [1, 1],
    ]);
    expect(frames.slice(1).map((frame) => frame.sharedInputUploadBytes)).toEqual([0, 0]);
  });
  it('produces compact visible IDs and portable indirect args on the real GPU API', async () => {
    await expect(runGpuDrivenViewGpuEvidence()).resolves.toEqual({
      visibleInstance: 0,
      indexCount: 12,
      instanceCount: 1,
      firstIndex: 9,
      baseVertex: 4,
      firstInstance: 0,
      overflow: 0,
      persistentTranslationX: 0,
      firstReadbackFrame: 10,
      recoveredReadbackFrame: 11,
      firstVisible: 1,
      recoveredVisible: 0,
    });
  });

  it('survives 60 frames of spawn/despawn capacity crossings without stale buffers', async () => {
    await expect(runGpuDrivenViewLifecycleEvidence()).resolves.toEqual({
      frames: 60,
      bufferRebuilds: 4,
      candidateCapacity: 8,
    });
  }, 30_000);

  it('culls only fully hidden instances through the two-phase HZB test', async () => {
    const frames = await runGpuDrivenViewOcclusionEvidence();
    expect(frames.map(({ visible, culled, late }) => ({ visible, culled, late }))).toEqual([
      // No history: the early phase draws everything; the late test records the hidden cube.
      { visible: 3, culled: 1, late: 0 },
      // Two-phase: the hidden cube skips the early phase and stays culled.
      { visible: 2, culled: 1, late: 0 },
      // The wall is gone: the hidden cube returns only through the late phase.
      { visible: 3, culled: 0, late: 1 },
    ]);
    // A capable draw addresses the late mirror in the whole visible buffer.
    expect(frames[2]?.lateCommands).toEqual([
      {
        instanceCount: 1,
        firstInstance: (frames[2]?.lateVisibleByteOffset ?? -16) / 16,
        mirrorMatchesUnion: true,
      },
    ]);
    // The same allocation also serves the portable window-binding path;
    // three cubes once put its mirror at the unaligned byte offset 64.
    for (const frame of frames) expect(frame.lateVisibleByteOffset % 256).toBe(0);
  });

  it('runs the late phase without indirect-first-instance through the visible mirror', async () => {
    const frames = await runGpuDrivenViewOcclusionEvidence({ firstInstanceIndirect: false });
    expect(frames.map(({ visible, culled, late }) => ({ visible, culled, late }))).toEqual([
      { visible: 3, culled: 1, late: 0 },
      { visible: 2, culled: 1, late: 0 },
      { visible: 3, culled: 0, late: 1 },
    ]);
    // A nonzero indirect firstInstance is invalid without the feature, so the
    // late command must start at zero of its own mirrored window.
    expect(frames[2]?.lateCommands).toEqual([
      { instanceCount: 1, firstInstance: 0, mirrorMatchesUnion: true },
    ]);
  });

  it('keeps HZB visibility history across a view buffer rebuild', async () => {
    const frames = await runGpuDrivenViewOcclusionEvidence({ grow: true });
    expect(frames[2]?.bufferRebuilds).toBeGreaterThan(frames[1]?.bufferRebuilds ?? Infinity);
    // Five cubes join beside the wall with no history and draw through the late
    // phase; the hidden cube keeps its culled history instead of drawing early
    // because the rebuilt counters lost it.
    expect(frames[2]).toMatchObject({ visible: 7, culled: 1, late: 5 });
    expect(frames[2]?.lateCommands).toEqual([
      {
        instanceCount: 5,
        firstInstance: (frames[2]?.lateVisibleByteOffset ?? -16) / 16,
        mirrorMatchesUnion: true,
      },
    ]);
  });

  it('FALSIFY: a shrunken HZB footprint culls the partially visible instance', async () => {
    const frames = await runGpuDrivenViewOcclusionEvidence({ occlusionFootprintScale: 0.3 });
    expect(frames[1]).toMatchObject({ visible: 1, culled: 2, late: 0 });
  });

  // A 64-texel PCF3 map: one texel of filter radius plus the two-texel margin.
  const pcf3 = shadowCameraCullDilation(1, 0, 64)?.ndcDilation ?? Number.NaN;

  // This Windows Dawn case took 104 seconds on 2026-10-22 and exceeded its 90-second limit.
  it('culls a shadow caster only when every receiver it can darken is hidden', async () => {
    await expect(
      runGpuDrivenShadowCameraCullEvidence({ light: 'camera', wall: 'left', ndcDilation: pcf3 }),
    ).resolves.toEqual({ visible: 2, cameraCulled: 1 });
  }, 150_000);

  it('keeps a hidden caster whose receiver prism reaches visible ground', async () => {
    // The x = -1 caster is behind the wall (the camera-light case above culls
    // it), yet its side-light shadow sweeps across the visible right half.
    await expect(
      runGpuDrivenShadowCameraCullEvidence({ light: 'side', wall: 'left', ndcDilation: pcf3 }),
    ).resolves.toEqual({ visible: 3, cameraCulled: 0 });
  });

  it('FALSIFY: the same side-light prisms cull once the wall hides every receiver', async () => {
    await expect(
      runGpuDrivenShadowCameraCullEvidence({ light: 'side', wall: 'all', ndcDilation: pcf3 }),
    ).resolves.toEqual({ visible: 0, cameraCulled: 3 });
  });

  it('FALSIFY: without the PCF dilation the caster at the wall edge loses its shadow', async () => {
    await expect(
      runGpuDrivenShadowCameraCullEvidence({ light: 'camera', wall: 'left', ndcDilation: 0 }),
    ).resolves.toEqual({ visible: 1, cameraCulled: 2 });
  });

  it('admits every caster when the light matrix has no inverse', async () => {
    await expect(
      runGpuDrivenShadowCameraCullEvidence({ light: 'singular', wall: 'all', ndcDilation: pcf3 }),
    ).resolves.toEqual({ visible: 3, cameraCulled: 0 });
  });

  it('admits every caster when a bound shadow view has no camera cull input', async () => {
    await expect(
      runGpuDrivenShadowCameraCullEvidence({ light: 'camera', wall: 'all' }),
    ).resolves.toEqual({ visible: 3, cameraCulled: 0 });
  });
});
