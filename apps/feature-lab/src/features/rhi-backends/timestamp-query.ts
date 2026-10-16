import { CheckList, defineFeature } from '../../lab/feature';
import { readBack, shader, webgpuDevice } from './support/gpu';

export default defineFeature({
  title: 'Timestamp query',
  catalog: 'Timestamp query',
  kind: 'probe',
  summary:
    "When the adapter exposes 'timestamp-query', a device requested with that feature accepts compute-pass timestampWrites and resolves real GPU ticks; without it, QuerySet creation is a structured refusal.",
  expect:
    "All checks pass: a device without the feature refuses a timestamp QuerySet with 'feature-not-enabled'; when the adapter supports it, the enabled device resolves two ticks with end >= begin.",
  setup({ app }) {
    return {
      async checks() {
        const checks = new CheckList();
        const caps = app.renderer.inspect().capabilities;
        checks.ok(
          'lab renderer reports timestamp capability as data',
          typeof caps.timestampQuery === 'boolean',
          `timestampQuery=${caps.timestampQuery} period=${caps.timestampPeriodNanoseconds}`,
        );

        const plain = await webgpuDevice(checks);
        if (plain === undefined) return checks.items;
        const refused = plain.device.createQuerySet({ type: 'timestamp', count: 2 });
        checks.ok('device without the feature refuses a timestamp QuerySet', !refused.ok);
        if (!refused.ok) {
          checks.equal('refusal code', refused.error.code, 'feature-not-enabled');
          checks.ok(
            'refusal hint names timestamp-query',
            refused.error.hint.includes('timestamp-query'),
            refused.error.hint,
          );
        }

        if (!plain.adapterFeatures.has('timestamp-query')) {
          checks.ok('adapter lacks timestamp-query; refusal is the whole contract here', true);
          return checks.items;
        }
        const timed = await webgpuDevice(checks, ['timestamp-query']);
        if (timed === undefined) return checks.items;
        const { device } = timed;
        checks.equal('enabled device caps.timestampQuery', device.caps.timestampQuery, true);
        const module = await shader(checks, device, '@compute @workgroup_size(1) fn probe() {}');
        if (module === undefined) return checks.items;
        const pipeline = device.createComputePipeline({
          layout: 'auto',
          compute: { module, entryPoint: 'probe' },
        });
        const querySet = device.createQuerySet({ type: 'timestamp', count: 2 });
        const resolve = device.createBuffer({
          size: 256,
          usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
        });
        const readback = device.createBuffer({
          size: 256,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
        const encoder = device.createCommandEncoder({ label: 'lab-timestamp' });
        checks.ok(
          'timestamp resources created',
          pipeline.ok && querySet.ok && resolve.ok && readback.ok && encoder.ok,
        );
        if (!pipeline.ok || !querySet.ok || !resolve.ok || !readback.ok || !encoder.ok)
          return checks.items;
        const pass = encoder.value.beginComputePass({
          timestampWrites: {
            querySet: querySet.value,
            beginningOfPassWriteIndex: 0,
            endOfPassWriteIndex: 1,
          },
        });
        pass.setPipeline(pipeline.value);
        pass.dispatchWorkgroups(64);
        pass.end();
        checks.ok(
          'resolveQuerySet ok',
          encoder.value.resolveQuerySet(querySet.value, 0, 2, resolve.value, 0).ok,
        );
        encoder.value.copyBufferToBuffer(resolve.value, 0, readback.value, 0, 16);
        const finished = encoder.value.finish();
        if (!finished.ok) return checks.ok('finish ok', false, finished.error.code).items;
        checks.ok('queue.submit ok', device.queue.submit([finished.value]).ok);
        const bytes = await readBack(device, readback.value, 16);
        if (typeof bytes === 'string') return checks.ok('timestamp readback', false, bytes).items;
        const [begin, end] = new BigUint64Array(bytes);
        checks.ok(
          'resolved ticks are ordered (end >= begin, begin > 0)',
          begin !== undefined && end !== undefined && begin > 0n && end >= begin,
          `begin=${begin} end=${end}`,
        );
        return checks.items;
      },
    };
  },
});
