// Heavy Dawn carriers keep one module graph for each recovery sequence.
// Failed async GPU tests must not overlap in-process retries.
// Each file gets a fresh process so native compilation cannot accumulate across
// unrelated carriers; in-file recovery state remains intact.
export const DAWN_HEAVY_TEST_PARTITIONS = Object.freeze(
  [
    'packages/runtime/src/__tests__/dawn/material-alpha.dawn.test.ts',
    'apps/parity/color-lighting/cases/tone/__tests__/tone-ramp.dawn.test.ts',
    'packages/runtime/src/__tests__/fullscreen-post-process-pass.dawn.test.ts',
    'packages/runtime/src/__tests__/shadow-csm-runtime-vary.dawn.test.ts',
  ].map((file) => Object.freeze([file])),
);
