import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  checkContactCoverage,
  contactCoverageWork,
  createContactCoveragePipelines,
  screenContactCoverageCases,
} from './screen-probe-contact-coverage.fixture';

it('keeps unqualified receiver coverage incomplete at the actual World contact admission seam', {
  timeout: 60_000,
}, async () => {
  const cases = await screenContactCoverageCases();
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw Error('Receiver coverage requires an actual adapter');
  const info = adapter.info;
  const actualAdapter = {
    info: {
      vendor: info.vendor,
      architecture: info.architecture,
      device: info.device,
      description: info.description,
    },
    isFallbackAdapter:
      'isFallbackAdapter' in adapter && typeof adapter.isFallbackAdapter === 'boolean'
        ? adapter.isFallbackAdapter
        : null,
  };
  const device = await adapter.requestDevice(),
    errors: string[] = [];
  const actualDeviceFeatures = [...device.features];
  device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const raw: { name: string; bytes: Uint8Array; scope: string }[] = [];
  let opaqueProof: Uint8Array | undefined;
  try {
    const pipelines = await createContactCoveragePipelines(device);
    for (const row of cases) {
      const work = contactCoverageWork(device, row);
      try {
        const bytes = await work.run(pipelines.prepare, pipelines.world);
        raw.push({
          name: row.name,
          bytes,
          scope:
            'Actual production preparation and World admission prefix; WORLD means query still required',
        });
        checkContactCoverage(bytes, row.ready, row.ready ? 1 : 4);
        if (row.name === 'opaque-selected') opaqueProof = bytes.slice(0, 96);
        if (row.name === 'new-source-epoch') {
          if (!opaqueProof) throw Error('Earlier actual GPU proof required');
          const stale = await work.run(undefined, pipelines.world, opaqueProof);
          raw.push({
            name: 'old-proof-new-epoch',
            bytes: stale,
            scope: 'Actual new producer epoch rejects the earlier GPU proof before opacity testing',
          });
          checkContactCoverage(stale, true, 4);
        }
      } finally {
        work.dispose();
      }
    }
    const unknown = cases.find((row) => row.name === 'unknown-selected');
    if (!unknown) throw Error('Actual partial packet required');
    const work = contactCoverageWork(device, unknown);
    try {
      // Controlled faulty producer, not a claimed legitimate material update:
      // actual GPU preparation with ONLY its opaque gate removed makes this proof.
      const buggy = await work.run(pipelines.faultyPrepare, pipelines.world);
      raw.push({
        name: 'prepare-only-fault-contained',
        bytes: buggy,
        scope: 'Faulty GPU producer is rejected by the production contact/World gate',
      });
      checkContactCoverage(buggy, true, 4);
      const unguarded = await work.run(undefined, pipelines.faultyContact);
      raw.push({
        name: 'contact-only-fault-admitted',
        bytes: unguarded,
        scope:
          'Same GPU-produced faulty proof; removing contact guard incorrectly admits query, never called MISS',
      });
      expect(unguarded.subarray(0, 96)).toEqual(buggy.subarray(0, 96));
      checkContactCoverage(unguarded, true, 1);
      expect(() => checkContactCoverage(unguarded, true, 4)).toThrow();
    } finally {
      work.dispose();
    }
    expect(errors).toEqual([]);
  } finally {
    try {
      const directory = process.env.FORGEAX_SCREEN_CONTACT_COVERAGE_OUTPUT;
      if (directory) {
        mkdirSync(directory, { recursive: true });
        for (const row of raw) writeFileSync(join(directory, `${row.name}.raw`), row.bytes);
        writeFileSync(
          join(directory, 'result.json'),
          JSON.stringify(
            {
              actualAdapter,
              actualDeviceFeatures,
              scope:
                'Receiver coverage admission component only, no World intersection or GI image qualification',
              records: raw.map(({ bytes, ...row }) => ({ ...row, byteLength: bytes.byteLength })),
              errors,
            },
            null,
            2,
          ),
        );
      }
    } finally {
      device.destroy();
    }
  }
});
