import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import { captureWhiteBalance, verifyWhiteBalance } from './white-balance.gpu-fixture';

it('converts adapted XYZ to linear sRGB in the production graph and RHI replay', async () => {
  const evidence = await captureWhiteBalance();
  const directory = process.env.FORGEAX_WHITE_BALANCE_EVIDENCE;
  if (directory) {
    mkdirSync(directory, { recursive: true });
    const { bytes, ...facts } = evidence;
    writeFileSync(join(directory, 'white-balance.rhitape'), bytes);
    writeFileSync(join(directory, 'white-balance.json'), JSON.stringify(facts, null, 2));
  }
  verifyWhiteBalance(evidence);
});
