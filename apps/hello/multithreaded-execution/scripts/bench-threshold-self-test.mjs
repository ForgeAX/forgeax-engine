import { assessProductImprovement } from './benchmark-statistics.mjs';

const samples = (value) => Array.from({ length: 240 }, () => value);
const accepted = assessProductImprovement(samples(20), samples(16));
const rejected = assessProductImprovement(samples(20), samples(18));
const outlierRejected = assessProductImprovement(
  [100, ...Array.from({ length: 239 }, () => 20)],
  samples(18),
);

if (!accepted.passed || rejected.passed || outlierRejected.passed) {
  throw new Error('product benchmark threshold falsification failed');
}
process.stdout.write('[product-bench] 20% fixture accepted; 10% and single-outlier fixtures rejected\n');
