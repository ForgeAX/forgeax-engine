import { packGlobalSdfQuerySettings } from '../../raytracing/global-sdf-query';
import {
  packScreenProbeFrame,
  SCREEN_PROBE_RECORD_BYTES,
} from '../../raytracing/screen-probe-plan';
import { packControlledCardFacingProbe } from './screen-probe-card-facing.fixture';

/** Controlled hardware World inputs, without a canonical receiver certificate. */
export function packCardSamplingInputs() {
  const probes = new Uint8Array(2 * SCREEN_PROBE_RECORD_BYTES);
  for (const [i, x] of [-0.1, 0.1].entries()) {
    const probe = packControlledCardFacingProbe();
    new Float32Array(probe.buffer).set([x, -0.25, 1, 1, 0, 0, 1]);
    new Uint32Array(probe.buffer)[7] = i;
    probes.set(probe, i * SCREEN_PROBE_RECORD_BYTES);
  }
  // The existing query owner supplies its default policy; this grid only
  // validates that policy and does not certify the controlled hardware geometry.
  const query = packGlobalSdfQuerySettings({
    origin: [0, 0, 0],
    dimensions: [4, 4, 4],
    spacing: 1,
    maxDistance: 4,
    coverageDistance: 0,
  }).unwrap();
  const frame = packScreenProbeFrame({
    layout: {
      width: 2,
      height: 1,
      tilesX: 2,
      tilesY: 1,
      uniformCount: 2,
      adaptiveCapacity: 0,
      probeCount: 2,
    },
    worldSource: { traversal: 'ray-query' },
    downsample: 8,
    frameIndex: 0,
    importance: 'uniform',
    screenSteps: 0,
    thickness: 0,
    environment: [0, 0, 0],
    maxDistance: 4,
    shortRangeAo: 0,
    maxFrames: 0,
    sceneHistory: false,
    pixelHistory: false,
    probeHistory: false,
    worldBias: 0,
    cardMargin: 0,
    query,
    reprojection: undefined,
  });
  return { probes, frame };
}
