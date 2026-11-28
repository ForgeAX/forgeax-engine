import {
  cookGerstnerWaveSet,
  type WaterBodySnapshot,
  type WaterWaveSetAsset,
} from '@forgeax/engine/water';

/** Only the selected Body's admitted public dependency can set this scene policy. */
export function causticsTextureWaveSet(body: WaterBodySnapshot | undefined) {
  const dependency = body?.dependencies.find(
    (entry) => entry.field === 'waveSetGuid' && entry.guid === body.asset.waveSetGuid,
  );
  const payload = dependency?.payload;
  return dependency?.status === 'valid' &&
    payload !== null &&
    typeof payload === 'object' &&
    'kind' in payload &&
    payload.kind === 'water-wave-set'
    ? (payload as WaterWaveSetAsset)
    : undefined;
}

/** R3's artistic texture cadence follows wave energy; this is not an optical solver. */
export function createCausticsTextureClock() {
  let accepted: WaterWaveSetAsset | undefined;
  let angularFrequency = 0;
  let sourceTimeSeconds = 0;
  let phase = 0;
  return {
    sample(waveSet: WaterWaveSetAsset | undefined, timeSeconds: number) {
      if (waveSet !== accepted) {
        accepted = waveSet;
        angularFrequency = 0;
        if (waveSet?.timeSource === 'scene-clock') {
          const cooked = cookGerstnerWaveSet(waveSet);
          if (cooked.ok) {
            let energy = 0;
            let weightedFrequency = 0;
            for (const wave of cooked.value.waves) {
              const weight = wave.amplitudeM ** 2;
              energy += weight;
              weightedFrequency += weight * wave.omegaPerSec;
            }
            angularFrequency = energy > 0 ? weightedFrequency / energy : 0;
          }
        }
      }
      sourceTimeSeconds = timeSeconds;
      phase = sourceTimeSeconds * angularFrequency;
      return phase;
    },
    readState: () => ({
      waveSetDigest: accepted?.inputDigest,
      timeSource: accepted?.timeSource,
      angularFrequency,
      sourceTimeSeconds,
      phase,
    }),
  };
}
