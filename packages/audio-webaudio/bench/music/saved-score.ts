import type { MusicScore } from '@forgeax/engine/audio';

export function savedScore(count: number, base = 2300): MusicScore {
  return { bpm: 120, beatsPerBar: 4, loopBeats: 4,
    stems: Array.from({ length: count }, (_, stem) => ({ clip: `aaaaaaaa-aaaa-4aaa-8aaa-${String(stem + base).padStart(12, '0')}` })) };
}

export function resampledScore(commonPhase: boolean): MusicScore {
  const score=savedScore(4, commonPhase ? 2510 : 2500);
  return { ...score, bpm: 137,
    stems: score.stems.map((stem,index) => ({ ...stem,
      offsetSeconds: commonPhase ? (index+1)*6400/48000 : (index+1)/8 })) };
}
