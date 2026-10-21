import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { instrumentFeaturePlanCensus } from '../feature_plan_census.mjs';
import {
  configureFeaturePlanCensus,
  createFeaturePlanCensus,
} from '../feature_plan_census_runtime.mjs';

const selection = { windowId: 'selected-active-plan', featureIdentity: 'stock', frameNumber: 7 };
const input = { frameNumber: 7, generation: 2, owner: 19 };
const runtimeModule = new URL('../feature_plan_census_runtime.mjs', import.meta.url).href;
const typescript = () =>
  import(process.env.FORGEAX_CENSUS_TYPESCRIPT ?? 'typescript').then((m) => m.default);

test('disabled overlay is byte-identical and does not load or wrap anything', () => {
  const source = 'export const untouched = () => 42;';
  assert.deepEqual(instrumentFeaturePlanCensus(null, '/features/host.ts', source), {
    source,
    hooks: [],
    disabled: true,
  });
});

test('one exact selected frame, safe descriptors, and old detached snapshots', () => {
  let clocks = 0,
    getter = 0;
  const census = createFeaturePlanCensus(selection, () => ++clocks);
  assert.equal(census.start('off', []), undefined);
  assert.equal(
    census.begin(
      {
        get frameNumber() {
          getter++;
          return 7;
        },
      },
      'stock',
    ),
    undefined,
  );
  assert.equal(census.begin({ ...input, frameNumber: 6 }, 'stock'), undefined);
  assert.equal(clocks, 0);
  assert.equal(getter, 0);
  const token = census.begin(input, 'stock');
  census.transaction({ generation: 2 });
  census.scope({ view: 'camera-main' });
  const call = census.start('gpu-session.resolveBuffer', [{}]);
  census.returned(call, undefined);
  census.end(call);
  census.finish(token, 0);
  const snapshot = census.snapshot();
  assert.equal(snapshot.identity.owner, 19);
  assert.equal(snapshot.identity.preparedGeneration, 2);
  assert.equal(snapshot.rows[0].scope, 'view:camera-main');
  assert.equal(census.begin(input, 'stock'), undefined);
  assert.equal(census.start('later-frame'), undefined);
  assert.ok(Object.isFrozen(snapshot.rows[0]));
  assert.equal(census.snapshot(), snapshot);
});

test('reference population separates logical results and own physical handles without getter reads', () => {
  let reads = 0;
  const census = createFeaturePlanCensus(selection, () => 0),
    token = census.begin(input, 'stock');
  const argument = {},
    buffer = {};
  for (let i = 0; i < 2; i++) {
    const call = census.start('gpu-session.resolveBuffer', [argument]);
    const value = { buffer };
    assert.equal(census.returned(call, value, 'resource'), value);
    census.end(call);
  }
  const call = census.start('raw-result', []);
  const value = {
    get ok() {
      reads++;
      return true;
    },
    get handle() {
      reads++;
      return buffer;
    },
  };
  assert.equal(census.returned(call, value), value);
  census.end(call);
  census.finish(token, 0);
  const row = census.snapshot().rows[0];
  assert.equal(row.sameArgumentTuple, 1);
  assert.equal(row.sameReturnedReference, 0);
  assert.equal(row.samePhysicalResource, 1);
  assert.equal(reads, 0);
});

test('opaque proxy results acquire only reference identity without descriptor traps', () => {
  let traps = 0;
  const value = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        traps++;
        throw new Error('opaque');
      },
    },
  );
  const census = createFeaturePlanCensus(selection, () => 0),
    token = census.begin(input, 'stock');
  const call = census.start('custom-result');
  assert.equal(census.returned(call, value), value);
  census.end(call);
  census.finish(token, 0);
  assert.equal(traps, 0);
  assert.equal(census.snapshot().rows[0].physicalUnobservedReturns, 1);
});

test('physical reuse across views is separate from same-scope reuse and tuple spelling', () => {
  const census = createFeaturePlanCensus(selection, () => 0),
    token = census.begin(input, 'stock');
  const buffer = {};
  census.scope({ view: 'first' });
  let call = census.start('gpu-session.resolveBuffer', ['a|string:b']);
  census.returned(call, { buffer }, 'resource');
  census.end(call);
  call = census.start('gpu-session.resolveBuffer', ['a', 'b']);
  census.returned(call, { buffer }, 'resource');
  census.end(call);
  census.scope({ view: 'second' });
  call = census.start('gpu-session.resolveBuffer', ['a', 'b']);
  census.returned(call, { buffer }, 'resource');
  census.end(call);
  census.finish(token, 0);
  assert.equal(census.snapshot().rows[0].sameArgumentTuple, 0);
  assert.equal(census.snapshot().rows[0].samePhysicalResource, 1);
  assert.equal(census.snapshot().rows[1].samePhysicalResource, 0);
  assert.equal(census.snapshot().rows[1].samePhysicalOtherScope, 1);
});

test('absent optional provider does not invoke or evaluate callback arguments', () => {
  const census = createFeaturePlanCensus(selection, () => 0),
    token = census.begin(input, 'stock');
  let argumentsRead = 0;
  census.method({}, 'resolveGpuBuffer', 'provider')?.(++argumentsRead);
  census.finish(token, 0);
  assert.equal(argumentsRead, 0);
  assert.equal(census.snapshot().rows.length, 0);
});

test('exclusive wrapped time excludes nested operations', () => {
  let clock = 0;
  const census = createFeaturePlanCensus(selection, () => clock),
    token = census.begin(input, 'stock');
  const outer = census.start('outer');
  clock = 1;
  const inner = census.start('inner');
  clock = 3;
  census.returned(inner, undefined);
  census.end(inner);
  clock = 5;
  census.returned(outer, undefined);
  census.end(outer);
  census.finish(token, 0);
  assert.equal(census.snapshot().rows[0].inclusiveWrappedMs, 5);
  assert.equal(census.snapshot().rows[0].exclusiveWrappedMs, 3);
  assert.equal(census.snapshot().rows[1].exclusiveWrappedMs, 2);
});

test('upload wrapper preserves receiver, getter-before-arguments, exact return and throw', () => {
  const census = createFeaturePlanCensus(selection, () => 0),
    token = census.begin(input, 'stock');
  const order = [],
    result = {},
    failure = new Error('original');
  const receiver = {
    get writeBuffer() {
      order.push('method');
      return function (value) {
        assert.equal(this, receiver);
        order.push('call');
        if (value) throw failure;
        return result;
      };
    },
  };
  assert.equal(census.method(receiver, 'writeBuffer')((order.push('argument'), false)), result);
  assert.deepEqual(order, ['method', 'argument', 'call']);
  assert.throws(
    () => census.method(receiver, 'writeBuffer')(true),
    (e) => e === failure,
  );
  census.finish(token, 0);
  assert.equal(census.snapshot().rows[0].calls, 2);
  assert.equal(census.snapshot().rows[0].throws, 1);
});

test('operation and identity retention is explicitly bounded', () => {
  const census = createFeaturePlanCensus(selection, () => 0),
    token = census.begin(input, 'stock');
  for (let i = 0; i < 8195; i++) {
    const call = census.start('bounded', [i]);
    census.returned(call, undefined);
    census.end(call);
  }
  census.finish(token, 0);
  assert.equal(census.snapshot().rows[0].calls, 8192);
  assert.equal(census.snapshot().droppedCalls, 3);
});

test('maintained five source seams parse and disabled versions remain exact', async () => {
  const ts = await typescript();
  const root = new URL('../../../../', import.meta.url);
  const paths = [
    'features/host.ts',
    'features/prepared-gpu-work.ts',
    'features/prepared-graphics-store.ts',
    'features/native-resource-admission.ts',
    'prepare/prepared-graphics-resolver.ts',
  ];
  const counts = [];
  for (const path of paths) {
    const file = fileURLToPath(new URL(`packages/render/src/${path}`, root));
    const source = await readFile(file, 'utf8');
    assert.equal(instrumentFeaturePlanCensus(ts, file, source).source, source);
    const observed = instrumentFeaturePlanCensus(ts, file, source, {
      enabled: true,
      runtimeModule,
      selection,
    });
    counts.push(observed.hooks.length);
    assert.equal(observed.originalSha256.length, 64);
    assert.notEqual(observed.observedSha256, observed.originalSha256);
  }
  assert.deepEqual(counts, [5, 11, 3, 1, 9]);
});

test('actual upload expression overlay executes once, with exact failure identity and inactive return', async () => {
  const ts = await typescript();
  const source = `export function make(input) {
    const prepareBuffer = (name, descriptor) => {
      const written = input.device.queue.writeBuffer(descriptor, 0, name);
      return written;
    };
    return {prepareBuffer};
  }`;
  const observed = instrumentFeaturePlanCensus(ts, '/features/prepared-gpu-work.ts', source, {
    enabled: true,
    runtimeModule,
    selection,
  });
  const js = ts.transpileModule(observed.source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const module = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
  const census = configureFeaturePlanCensus(selection);
  let calls = 0;
  const returned = {},
    failure = new Error('original upload');
  const queue = {
    writeBuffer(value) {
      assert.equal(this, queue);
      calls++;
      if (value === null) throw failure;
      return returned;
    },
  };
  const api = module.make({ device: { queue } });
  assert.equal(api.prepareBuffer('before', {}), returned);
  const token = census.begin(input, 'stock');
  assert.equal(api.prepareBuffer('active', {}), returned);
  assert.throws(
    () => api.prepareBuffer('active', null),
    (e) => e === failure,
  );
  census.finish(token, 1);
  assert.equal(api.prepareBuffer('after', {}), returned);
  assert.equal(calls, 4);
  assert.equal(census.snapshot().rows.find((r) => r.operation === 'upload.writeBuffer').calls, 2);
});

test('lookup observation distinguishes actual shared inheritance without a second resolver call', () => {
  const census = createFeaturePlanCensus(selection, () => 0),
    token = census.begin(input, 'stock');
  let reads = 0;
  const value = {},
    read = () => {
      reads++;
      return value;
    };
  assert.equal(
    census.lookup('local', 'name', undefined) ?? census.lookup('inherited', 'name', read()),
    value,
  );
  census.finish(token, 0);
  assert.equal(reads, 1);
  assert.equal(census.snapshot().rows.length, 1);
  assert.equal(census.snapshot().rows[0].operation, 'resource-lookup/inherited');
  assert.equal(census.snapshot().rows[0].exclusiveWrappedMs, null);
});

test('bounded unavailable argument identity does not hide complete operation retention', () => {
  const census = createFeaturePlanCensus(selection, () => 0),
    token = census.begin(input, 'stock');
  const call = census.start('long-name', ['x'.repeat(257)]);
  census.returned(call, undefined);
  census.end(call);
  census.finish(token, 0);
  assert.equal(census.snapshot().populationStatus, 'partial');
  assert.equal(census.snapshot().argumentIdentityStatus, 'partial');
  assert.equal(census.snapshot().operationRetentionStatus, 'complete');
  assert.equal(census.snapshot().rows[0].sameArgumentTuple, 0);
});

test('selected feature transaction closes on continue and on an escaping original exception', async () => {
  const ts = await typescript();
  const source = `export function runRenderFeatureFrame(host, inputs) {
  const input = inputs[0], errors = [];
  for (const feature of host.features) {
    const identity = feature.identity;
    const transaction = host.beginPreparedFrame();
    if (transaction === undefined) continue;
    feature.plan();
  }
  return errors;
}`;
  const observed = instrumentFeaturePlanCensus(ts, '/features/host.ts', source, {
    enabled: true,
    runtimeModule,
    selection,
  });
  const js = ts.transpileModule(observed.source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const module = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
  let census = configureFeaturePlanCensus(selection);
  module.runRenderFeatureFrame(
    { features: [{ identity: 'stock' }], beginPreparedFrame: () => undefined },
    [input],
  );
  assert.equal(census.isActive(), false);
  assert.equal(census.snapshot().identity.transactionReference, undefined);
  census = configureFeaturePlanCensus(selection);
  const failure = new Error('original plan exception');
  assert.throws(
    () =>
      module.runRenderFeatureFrame(
        {
          features: [
            {
              identity: 'stock',
              plan() {
                throw failure;
              },
            },
          ],
          beginPreparedFrame: () => ({ generation: 2 }),
        },
        [input],
      ),
    (e) => e === failure,
  );
  assert.equal(census.isActive(), false);
  assert.equal(census.snapshot().escapedException, true);
  assert.equal(census.snapshot().identity.preparedGeneration, 2);
});
