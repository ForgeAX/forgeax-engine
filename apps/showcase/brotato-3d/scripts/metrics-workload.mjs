export function assertBrotatoWorkload(sample) {
  if (sample === null || typeof sample !== 'object') throw new TypeError('workload sample required');
  if (!Number.isInteger(sample.entityCount) || sample.entityCount < 1) {
    throw new RangeError('entityCount must be a positive integer');
  }
  if (!Number.isFinite(sample.fps) || sample.fps <= 0) throw new RangeError('fps must be positive');
  if (sample.provenance !== 'real-browser') throw new Error('real-browser provenance required');
  return sample;
}
