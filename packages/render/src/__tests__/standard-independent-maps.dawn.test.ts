import { mkdir, writeFile } from 'node:fs/promises';
import { _internal_getRawDevice } from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { verifyIndependentMaps } from './standard-independent-maps.fixture';

it('reads Standard scalar maps and replays the captured bindings and pixels on Dawn', async () => {
  const receipts = await verifyIndependentMaps((device) => {
    const raw = _internal_getRawDevice(device);
    const errors: string[] = [];
    raw?.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    return () => {
      raw?.destroy();
      expect(errors).toEqual([]);
    };
  });
  const directory = 'artifacts/standard-independent-maps';
  await mkdir(directory, { recursive: true });
  for (const receipt of receipts)
    await writeFile(`${directory}/${receipt.name}.rhitape`, receipt.bytes);
  await writeFile(
    `${directory}/evidence.json`,
    JSON.stringify(
      receipts.map(({ bytes: _bytes, ...receipt }) => receipt),
      null,
      2,
    ),
  );
}, 60_000);
