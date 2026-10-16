import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { it } from 'vitest';
import { assertUint4Readback } from './uint4-readback.assertions';
import { verifyUint4Readback } from './uint4-readback.fixture';

it('reads all four integer words at the selected work in a six-target pass', async ({ skip }) => {
  const result = await verifyUint4Readback();
  if (result.status === 'unavailable') return skip(result.reason);
  assertUint4Readback(result);
  const output = process.env.FORGEAX_UINT4_ARTIFACTS;
  if (output !== undefined) {
    await mkdir(output, { recursive: true });
    await Promise.all([
      writeFile(join(output, 'six-target.rhitape'), result.captured.bytes),
      writeFile(join(output, 'live.rgba32uint'), result.live),
      writeFile(join(output, 'work-0.rgba32uint'), result.before.bytes),
      writeFile(join(output, 'work-1.rgba32uint'), result.after.bytes),
      writeFile(
        join(output, 'result.json'),
        JSON.stringify(
          {
            status: result.status,
            width: 4,
            height: 2,
            format: 'rgba32uint',
            workCount: result.workCount,
            readbackBytes: result.live.byteLength,
            byteMismatchCount: result.live.filter(
              (value, index) => value !== result.after.bytes[index],
            ).length,
            tapeDigest: result.captured.digest,
            evidenceClass: 'software-gpu-diagnostic',
          },
          null,
          2,
        ),
      ),
    ]);
  }
});
