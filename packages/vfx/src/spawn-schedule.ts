import type { ParticleEmitterSourceBase } from './code-source.js';

/** Addressable schedule entropy. This owns spawn *times*, never particle
 * positions, velocities or GPU storage. There is no CPU particle simulation. */
function random(seed: number, identity: number): number {
  let value = (seed ^ Math.imul(identity >>> 0, 0x9e3779b9)) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return ((value ^ (value >>> 16)) >>> 0) / 0x100000000;
}
function emitterSeed(seed: number, id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return (hash ^ seed) >>> 0;
}
/** Slot i stays in [(i+1-randomness)/rate,(i+1)/rate]. Therefore
 * jittered slots stay ordered, never need a per-particle CPU queue, and the
 * crossed count is independent of how an interval was split into frames. */
function crossed(time: number, rate: number, jitter: number, seed: number): number {
  if (time < 0 || rate === 0) return 0;
  const exact = time * rate,
    whole = Math.floor(exact);
  return whole + Number(exact >= whole + 1 - jitter + random(seed, whole) * jitter);
}
export function countParticleSchedule(
  schedule: ParticleEmitterSourceBase['schedule'],
  id: string,
  seed: number,
  previous: number,
  next: number,
  firstTick: boolean,
  priorRemainder: number,
): { count: number; remainder: number } {
  const jitter = schedule.randomness ?? 0,
    key = emitterSeed(seed, id);
  const exact = schedule.rate * Math.max(0, next - previous) + priorRemainder;
  let count =
    jitter === 0
      ? Math.floor(exact)
      : crossed(next, schedule.rate, jitter, key) -
        (firstTick ? 0 : crossed(previous, schedule.rate, jitter, key));
  const remainder = jitter === 0 ? exact - Math.floor(exact) : 0;
  const before = firstTick ? -Number.EPSILON : previous;
  for (const [index, burst] of (schedule.bursts ?? []).entries()) {
    const spread = burst.spreadSeconds ?? 0,
      loop = schedule.loopDuration;
    const partial = (time: number, cycle: number) => {
      const age = time - burst.time - (loop ?? 0) * cycle;
      if (age < 0) return 0;
      if (spread === 0 || age >= spread) return burst.count;
      return Math.min(
        burst.count,
        crossed(age, burst.count / spread, jitter, key ^ Math.imul(index + 1, 0x85ebca6b) ^ cycle),
      );
    };
    const cumulative = (time: number) => {
      if (loop === undefined) return partial(time, 0);
      const last = Math.floor((time - burst.time) / loop);
      if (last < 0) return 0;
      // Validation bounds spread to one loop. Every older cycle is complete.
      return last * burst.count + partial(time, last);
    };
    count += cumulative(next) - cumulative(before);
  }
  return { count, remainder };
}
export const VFX_WARMUP_STEP_SECONDS = 1 / 60;
export const particleWarmupSteps = (schedule: ParticleEmitterSourceBase['schedule']): number =>
  Math.ceil((schedule.warmupSeconds ?? 0) / VFX_WARMUP_STEP_SECONDS);
