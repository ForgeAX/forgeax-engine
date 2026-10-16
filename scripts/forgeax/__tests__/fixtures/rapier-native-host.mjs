import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

const dimension = process.argv[2];
assert.ok(['2d', '3d'].includes(dimension));
const owner = new URL(`../../../../packages/physics-rapier${dimension}/`, import.meta.url);
const bytes = new Uint8Array(await readFile(new URL('pkg/rapier.wasm', owner)));
// Node 22 lazily compiles its HTTP parser when Assets inspects Response.
// Finish Host bootstrap before restricting the subject; a real response awaits
// that asynchronous compilation without importing any Engine/Rapier module.
const server = createServer((_, response) => {
  response.writeHead(200, { connection: 'close' });
  response.end('ready');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  const response = await fetch(`http://127.0.0.1:${server.address().port}`);
  assert.equal(await response.text(), 'ready');
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
const wasm = globalThis.WebAssembly;
const performanceDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance');
const hostPerformance = globalThis.performance;
globalThis.WebAssembly = undefined;
Object.defineProperty(globalThis, 'performance', { value: undefined, configurable: true });
try {
  const native = await import(new URL('dist/native.mjs', owner));
  const ordinary = await import(new URL('dist/index.mjs', owner));
  const initialize = native[`initializeNativeRapier${dimension.toUpperCase()}`];
  const load = ordinary[`loadRapier${dimension.toUpperCase()}`];
  assert.equal((await load()).code, 'wasm-load-failed');

  let reads = 0;
  let instantiations = 0;
  let clockReads = 0;
  const corrupt = bytes.slice();
  corrupt[corrupt.length - 1] ^= 1;
  for (const invalid of [corrupt, bytes.subarray(1)]) {
    const failure = await initialize({
      now: () => hostPerformance.now(),
      readWasm: async () => invalid,
      instantiate: async () => {
        instantiations += 1;
        throw new Error('must not instantiate');
      },
    });
    assert.equal(failure.code, 'wasm-load-failed');
    assert.match(failure.detail.reason, /differs/);
    assert.equal(instantiations, 0, 'digest/length rejection precedes instance adoption');
  }
  const rejected = await initialize({
    now: () => hostPerformance.now(),
    readWasm: async () => bytes,
    instantiate: async () => {
      throw new Error('host unavailable');
    },
  });
  assert.equal(rejected.code, 'wasm-load-failed');
  assert.match(rejected.detail.reason, /host unavailable/);
  assert.equal((await load()).code, 'wasm-load-failed');

  const missingClock = await initialize({
    readWasm: async () => bytes,
    instantiate: async () => {
      throw new Error('missing clock must fail before instantiation');
    },
  });
  assert.equal(missingClock.code, 'wasm-load-failed');
  assert.match(missingClock.detail.reason, /monotonic millisecond clock/);

  if (dimension === '3d') {
    const invalidExports = await initialize({
      now: () => hostPerformance.now(),
      readWasm: async () => bytes,
      instantiate: async () => ({
        instance: {
          get exports() {
            throw new Error('host exports unavailable');
          },
        },
      }),
    });
    assert.equal(invalidExports.code, 'wasm-load-failed');
    assert.match(invalidExports.detail.reason, /host exports unavailable/);
  }

  const host = {
    now() {
      assert.equal(this, host);
      clockReads += 1;
      return hostPerformance.now();
    },
    readWasm: async () => {
      reads += 1;
      return bytes;
    },
    instantiate: async (imports) => {
      instantiations += 1;
      return wasm.instantiate(bytes, imports);
    },
  };
  const first = initialize(host);
  assert.equal(initialize(host), first, 'concurrent initializers share one attempt');
  const RAPIER = await first;
  assert.equal(await load(), RAPIER, 'ordinary entry consumes the native Host singleton');
  assert.equal(await initialize(host), RAPIER);
  assert.equal(reads, 1);
  assert.equal(instantiations, 1);
  assert.equal(RAPIER.version(), '0.20.0');
  const binding = await import(new URL('pkg/rapier-native.mjs', owner));
  assert.ok(Object.isFrozen(binding.artifact));

  // Exercise the ordinary Engine backend around the actual generated binary.
  const physics = ordinary[`createRapier${dimension.toUpperCase()}PhysicsWorld`](RAPIER);
  const raw = physics.raw;
  const position = (y) => (dimension === '2d' ? [0, y] : [0, y, 0]);
  const floorSize = dimension === '2d' ? [10, 0.1] : [10, 0.1, 10];
  const floor = raw.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(...position(-0.1)));
  raw.createCollider(RAPIER.ColliderDesc.cuboid(...floorSize), floor);
  const body = raw.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(...position(2)));
  raw.createCollider(RAPIER.ColliderDesc.ball(0.5).setRestitution(0), body);
  for (let frame = 0; frame < 60; frame += 1) physics.step(1 / 60);
  const settledY = body.translation().y;
  assert.ok(Math.abs(settledY - 0.5) < 0.05, `ball must settle on real floor: ${settledY}`);
  assert.ok(Math.abs(body.linvel().y) < 0.05, 'contact must stop downward velocity');
  assert.ok(clockReads > 0, 'actual native timers consume the explicit Host clock');
  physics.dispose();
  assert.equal(globalThis.WebAssembly, undefined);
  assert.equal(globalThis.performance, undefined);
  process.stdout.write(
    `${JSON.stringify({ dimension, frames: 60, settledY, instantiations, clockReads })}\n`,
  );
} finally {
  globalThis.WebAssembly = wasm;
  Object.defineProperty(globalThis, 'performance', performanceDescriptor);
}
