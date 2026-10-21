import { it } from 'vitest';
import { verifyPreparedPipelineCapture } from './pipeline-library-capture.fixture';

it('keeps native pipeline warmup, 60 completed frames, capture, replay pixels and GPU timing through the recorder', {
  timeout: 60_000,
}, async () => {
  await verifyPreparedPipelineCapture();
});
