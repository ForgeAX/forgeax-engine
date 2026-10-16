import type { RhiDevice } from '@forgeax/engine/rhi';
import { rhi } from '@forgeax/engine/rhi-null';
import { defineFeature } from '../../lab/feature';

const STORAGE = 0x80;
const COPY_DST = 0x08;

export default defineFeature({
  title: 'Spec-aligned RHI',
  catalog: 'Spec-aligned RHI',
  kind: 'headless',
  summary:
    'The RHI is a WebGPU-shaped, math-free interface: strict adapter -> device discovery, every create* returns a Result, and misuse becomes a structured error instead of an exception.',
  expect:
    "All checks pass on the headless backend: create* return Result values, a second destroy returns 'destroy-after-destroy' with expected/hint, and caps survive a JSON round trip.",
  async run(checks) {
    const adapter = await rhi.requestAdapter();
    checks.ok('rhi.requestAdapter() returns ok', adapter.ok);
    if (!adapter.ok) return;
    const created = await adapter.value.requestDevice();
    checks.ok('adapter.requestDevice() returns ok', created.ok);
    if (!created.ok) return;
    const device: RhiDevice = created.value;

    const buffer = device.createBuffer({ label: 'lab', size: 64, usage: STORAGE | COPY_DST });
    checks.ok('createBuffer returns ok Result', buffer.ok);
    if (!buffer.ok) return;
    checks.ok(
      'queue.writeBuffer returns ok Result',
      device.queue.writeBuffer(buffer.value, 0, new Uint32Array(4)).ok,
    );

    const first = device.destroyBuffer(buffer.value);
    const second = device.destroyBuffer(buffer.value);
    checks.ok('first destroy ok', first.ok);
    checks.ok('second destroy is an err Result (no throw)', !second.ok);
    if (!second.ok) {
      checks.equal('second destroy code', second.error.code, 'destroy-after-destroy');
      checks.ok(
        'error carries expected + hint',
        second.error.expected.length > 0 && second.error.hint.length > 0,
      );
    }

    const caps = JSON.parse(JSON.stringify(device.caps)) as Record<string, unknown>;
    checks.equal('caps is plain data (JSON round trip)', caps, { ...device.caps });
  },
});
