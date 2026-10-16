import { it } from 'vitest';
import { verifyRasterTimestampEnvelope } from './raster-envelope-probe.fixture';

it('compares native WebGPU and RHI query pairs and pixels on Dawn', async ({ skip, annotate }) => {
  const evidence = await verifyRasterTimestampEnvelope(skip);
  await annotate('Native and RHI raster timestamps and readback pixels', {
    body: JSON.stringify(evidence, null, 2),
    bodyEncoding: 'utf-8',
    contentType: 'application/json',
  });
});
