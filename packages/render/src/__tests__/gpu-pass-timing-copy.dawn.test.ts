import { it } from 'vitest';
import { verifyCopyTimingMarkers } from './gpu-pass-timing-copy.fixture';

it(
  'measures real copy boundaries over 60 completed Dawn frames and a graph change',
  verifyCopyTimingMarkers,
  60_000,
);
