#!/usr/bin/env node
// Use the same real transmission tests and native lifetime boundary as the
// complete Dawn gate, with the app's additional 60-frame roster receipt.
import { runDawnPartitions } from '../../../../../scripts/ci/run-dawn-partitions.mjs';

process.exitCode = await runDawnPartitions('transmission', {
  smokeOwner: process.argv[2],
  env: {
    ...process.env,
    FORGEAX_DAWN_ISOLATED: '1',
    FORGEAX_DAWN_ROSTER_SMOKE: '1',
    SMOKE_MIN_FRAMES: process.env.SMOKE_MIN_FRAMES ?? '60',
  },
});
