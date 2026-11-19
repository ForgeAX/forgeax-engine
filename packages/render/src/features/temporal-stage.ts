/** Public, cloneable ordering contract for native producer/consumer replay.
 * Ticks are source frame numbers, not wall-clock timestamps. */
export interface RenderFeatureTemporalStage {
  readonly timeline: string;
  readonly epoch: number;
  readonly tick: number;
  readonly phase: 'restore' | 'producer' | 'consumer';
}
export function validRenderFeatureTemporalStage(
  value: unknown,
): value is RenderFeatureTemporalStage {
  if (!value || typeof value !== 'object') return false;
  const v = value as RenderFeatureTemporalStage;
  return (
    Object.keys(v).every((k) => ['timeline', 'epoch', 'tick', 'phase'].includes(k)) &&
    typeof v.timeline === 'string' &&
    v.timeline.length > 0 &&
    Number.isSafeInteger(v.epoch) &&
    v.epoch >= 0 &&
    Number.isSafeInteger(v.tick) &&
    v.tick >= 0 &&
    ['restore', 'producer', 'consumer'].includes(v.phase)
  );
}
export function compareRenderFeatureTemporalStage(
  a: RenderFeatureTemporalStage,
  b: RenderFeatureTemporalStage,
): number {
  const phase = { restore: 0, producer: 1, consumer: 2 };
  return (
    a.timeline.localeCompare(b.timeline) ||
    a.epoch - b.epoch ||
    a.tick - b.tick ||
    phase[a.phase] - phase[b.phase]
  );
}
