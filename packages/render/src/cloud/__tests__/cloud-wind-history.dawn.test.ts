import { mkdirSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { verifyCloudWindHistory } from './cloud-wind-history.fixture';

it('accepts advected history and rejects unadvected history, cuts and disocclusion', async () => {
  const dir =
    process.env.FORGEAX_CLOUD_WIND_EVIDENCE ?? 'artifacts/post-processing-maturity/cloud-wind/dawn';
  mkdirSync(dir, { recursive: true });
  await verifyCloudWindHistory((name, bytes) => {
    writeFileSync(`${dir}/${name}`, bytes);
  });
}, 30_000);
