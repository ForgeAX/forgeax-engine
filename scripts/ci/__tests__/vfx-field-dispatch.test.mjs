import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { isSimulationUpdate } from '../../../apps/hello/boss-lightning/scripts/smoke-diagnostics.mjs';

const source = readFileSync(
  new URL('../../../apps/hello/boss-lightning/scripts/smoke-fields-dawn.mjs', import.meta.url),
  'utf8',
);
const begin = source.indexOf('if(!performanceRun){');
const end = source.indexOf('nativeCreate=device.createBuffer', begin);
assert(begin > 0 && end > begin);
const instrument = runInNewContext(
  `(device) => {
  let simulationUpdates = 0;
  const performanceRun = false;
  ${source.slice(begin, end)}
  return () => simulationUpdates;
}`,
  { isSimulationUpdate },
);

test('the actual field-smoke observer counts full and compact GPU dispatches without counting view work', async () => {
  let forwarded = 0;
  const device = {
    createComputePipeline: () => ({}),
    createComputePipelineAsync: async () => ({}),
    createCommandEncoder: () => ({
      beginComputePass: () => ({
        setPipeline() {},
        dispatchWorkgroups() {
          forwarded++;
        },
        dispatchWorkgroupsIndirect() {
          forwarded++;
        },
      }),
    }),
  };
  const updates = instrument(device);
  for (const asyncPipeline of [false, true]) {
    const pass = device.createCommandEncoder().beginComputePass();
    for (const entryPoint of [
      'forgeax_vfx_update_main',
      'forgeax_vfx_update_compact_main',
      'forgeax_vfx_project_main',
      'forgeax_vfx_update_compact_main_extra',
    ]) {
      const descriptor = { compute: { entryPoint } };
      const pipeline = asyncPipeline
        ? await device.createComputePipelineAsync(descriptor)
        : device.createComputePipeline(descriptor);
      pass.setPipeline(pipeline);
      pass.dispatchWorkgroups(1);
      pass.dispatchWorkgroupsIndirect({}, 0);
    }
  }
  assert.equal(
    updates(),
    8,
    'both dispatch methods and both pipeline creation paths count exactly two simulation kernels',
  );
  assert.equal(forwarded, 16, 'instrumentation forwards every original native dispatch');
});
