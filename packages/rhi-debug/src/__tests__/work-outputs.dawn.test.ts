import { it } from 'vitest';
import { verifyComputeOutputs, verifyDepthOnlyLayerOutput } from './work-outputs.fixture';

it('reads a compute dispatch storage buffer and texture as work outputs', verifyComputeOutputs);
it('reads a depth-only array-layer pass as a depth image', verifyDepthOnlyLayerOutput);
