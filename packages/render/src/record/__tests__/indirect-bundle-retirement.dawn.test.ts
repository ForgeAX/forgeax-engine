import { it } from 'vitest';
import { indirectBundleRetirementFrames } from './indirect-bundle-retirement-fixture';

it(
  'reuses moved indirect segments after overwritten inherited resources are destroyed for 60 frames',
  indirectBundleRetirementFrames,
);
