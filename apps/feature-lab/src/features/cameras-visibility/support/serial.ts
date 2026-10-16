import type { FeatureCheck } from '../../../lab/feature';

// main.ts runs checks once after ready while the runner may call them again; a
// second concurrent run would interleave add/remove steps on the same entities.
export function serial(
  run: () => Promise<readonly FeatureCheck[]>,
): () => Promise<readonly FeatureCheck[]> {
  let inFlight: Promise<readonly FeatureCheck[]> | undefined;
  return () => {
    inFlight ??= run().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}
