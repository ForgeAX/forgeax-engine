import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { withLocalGpuLease } from '../local-gpu-lease.mjs';
import { runBrowserCommand } from '../run-browser-gate-with-retry.mjs';

test('Windows holder starts under a restricted inherited process policy without changing system policy', {
  skip: process.platform !== 'win32',
  timeout: 10000,
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-local-gpu-policy-'));
  try {
    const module = new URL('../local-gpu-lease.mjs', import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {withLocalGpuLease} from ${JSON.stringify(module)}; await withLocalGpuLease(()=>console.log('policy-scoped-holder-acquired'),{lockPath:process.argv[1]});`,
        join(directory, 'private lock'),
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 8000,
        env: { ...process.env, PSExecutionPolicyPreference: 'Restricted' },
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /policy-scoped-holder-acquired/);
    assert.match(result.stderr, /\[local-gpu\] acquired/);
    assert.match(result.stderr, /\[local-gpu\] released/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the standalone suite companion entrypoint runs and preserves its child exit', () => {
  for (const code of [0, 7]) {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('../local-gpu-lease.mjs', import.meta.url)),
        '--timeout-ms',
        '2000',
        '--',
        process.execPath,
        '-e',
        `console.log('companion'); process.exit(${code});`,
      ],
      {
        encoding: 'utf8',
        timeout: 5000,
        env: { ...process.env, FORGEAX_LOCAL_GPU_LEASE: '0', GITHUB_ACTIONS: 'false' },
      },
    );
    assert.equal(result.status, code, result.stderr);
    assert.match(result.stdout, /companion/);
  }
});

test('process-only mode budgets the complete child tree without taking the outer GPU lease', () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../local-gpu-lease.mjs', import.meta.url)),
      '--process-only',
      '--timeout-ms',
      '2000',
      '--',
      process.execPath,
      '-e',
      `console.log(JSON.stringify({budget:process.env.FORGEAX_LOCAL_PROCESS_BUDGET_HELD,lease:process.env.FORGEAX_LOCAL_GPU_LEASE_HELD??null}));`,
    ],
    {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, FORGEAX_LOCAL_GPU_LEASE: '1', FORGEAX_LOCAL_GPU_LEASE_HELD: '1' },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"budget":"1","lease":null/);
  assert.doesNotMatch(result.stdout + result.stderr, /\[local-gpu\] (queued|acquired)/);
});

test('process-only mode enforces its child budget and reclaims the owned process group', () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../local-gpu-lease.mjs', import.meta.url)),
      '--process-only',
      '--timeout-ms',
      '100',
      '--',
      process.execPath,
      '-e',
      'setInterval(() => {}, 1000);',
    ],
    { encoding: 'utf8', timeout: 5000, env: { ...process.env, FORGEAX_LOCAL_GPU_LEASE: '1' } },
  );
  assert.equal(result.status, 124, result.stderr);
  assert.match(result.stdout + result.stderr, /command deadline exceeded \(100 ms\)/);
  assert.doesNotMatch(result.stdout + result.stderr, /\[local-gpu\] (queued|acquired)/);
});

test('standalone owners reject missing or invalid complete process budgets before admission', () => {
  for (const budget of [
    [],
    ['--timeout-ms', '0'],
    ['--timeout-ms', '-1'],
    ['--timeout-ms', 'NaN'],
    ['--timeout-ms', 'Infinity'],
    ['--timeout-ms', '2147483648'],
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('../local-gpu-lease.mjs', import.meta.url)),
        ...budget,
        '--',
        process.execPath,
        '-e',
        "console.log('must-not-run')",
      ],
      { encoding: 'utf8', timeout: 5000, env: { ...process.env, FORGEAX_LOCAL_GPU_LEASE: '1' } },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(result.stdout, /must-not-run/);
    assert.doesNotMatch(result.stderr, /\[local-gpu\] (queued|acquired)/);
  }
});

test('a stalled module fails under the standalone budget, reclaims descendants and admits the next owner', {
  timeout: 15000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-stalled-module-'));
  const lockPath = join(directory, 'gpu.lock');
  const modulePath = join(directory, 'stalled.mjs');
  let queued;
  let descendant;
  writeFileSync(
    modulePath,
    `
    import { spawn } from 'node:child_process';
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); process.send(process.pid); setInterval(()=>{},1000)"],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    await new Promise(resolve => child.once('message', pid => { console.log('module-start descendant='+pid); resolve(); }));
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  `,
  );
  try {
    const result = await withLocalGpuLease(
      async () => {
        queued = withLocalGpuLease(
          async () => {
            assert.ok(descendant > 1);
            assert.throws(() => process.kill(descendant, 0), /ESRCH/);
            return 'next owner admitted';
          },
          { lockPath, label: 'successor' },
        );
        const native = await runBrowserCommand(
          [
            process.execPath,
            fileURLToPath(new URL('../local-gpu-lease.mjs', import.meta.url)),
            '--timeout-ms',
            '1800',
            '--',
            process.execPath,
            modulePath,
          ],
          {
            timeoutMs: 10000,
            env: { ...process.env, FORGEAX_LOCAL_GPU_LEASE: '0', GITHUB_ACTIONS: 'false' },
          },
        );
        descendant = Number(native.output.match(/descendant=(\d+)/)?.[1]);
        return native;
      },
      { lockPath, label: 'stalled module' },
    );
    assert.equal(result.status, 124, result.output);
    assert.match(result.output, /module-start/);
    assert.match(result.output, /command deadline exceeded \(1800 ms\)/);
    assert.equal(await queued, 'next owner admitted');
    assert.equal(existsSync(modulePath), true, 'failure inputs remain available');
  } finally {
    await queued?.catch(() => {});
    if (descendant) {
      try {
        process.kill(descendant, 'SIGKILL');
      } catch {}
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('parent death releases its lease and a missing POSIX holder cannot admit native work', {
  timeout: 10000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-local-gpu-'));
  const lockPath = join(directory, 'gpu.lock');
  const module = new URL('../local-gpu-lease.mjs', import.meta.url).href;
  let owner;
  try {
    if (process.platform !== 'win32') {
      const absent = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
      import { withLocalGpuLease } from ${JSON.stringify(module)};
      await withLocalGpuLease(async () => console.log('must-not-run'),
        { lockPath: process.argv[1] }).catch(error => { console.error(error.message); process.exitCode=1; });
    `,
          lockPath,
        ],
        { encoding: 'utf8', timeout: 5000, env: { ...process.env, PATH: directory } },
      );
      assert.equal(absent.status, 1);
      assert.match(absent.stderr, /ENOENT/);
      assert.doesNotMatch(absent.stdout, /must-not-run/);
    }
    owner = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { withLocalGpuLease } from ${JSON.stringify(module)};
      await withLocalGpuLease(async () => {
        console.log('held'); await new Promise(resolve => setInterval(resolve,100000));
      }, { lockPath: process.argv[1] });
    `,
        lockPath,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    owner.stdout.on('data', (chunk) => {
      output += chunk;
    });
    const closed = once(owner, 'close');
    while (!output.includes('held')) await sleep(20);
    owner.kill('SIGKILL');
    await closed;
    // This fixture has no native descendant; stdin closure must reclaim only
    // its orphaned holder, without unlinking the still-existing host lock.
    await withLocalGpuLease(async () => {}, { lockPath });
    assert.equal(existsSync(lockPath), true);
  } finally {
    if (owner?.exitCode === null) owner.kill('SIGKILL');
    rmSync(directory, { recursive: true, force: true });
  }
});

test('native execution keeps its deadline after a longer lock wait and releases between groups', {
  timeout: 10000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-local-gpu-'));
  const lockPath = join(directory, 'gpu.lock');
  const events = [];
  let queued;
  try {
    await withLocalGpuLease(
      async () => {
        events.push('first-start');
        queued = withLocalGpuLease(
          async () => {
            events.push('second-start');
            const result = await runBrowserCommand(
              [process.execPath, '-e', "console.log('real child');"],
              {
                timeoutMs: 2000,
                env: { ...process.env, GITHUB_ACTIONS: 'false' },
              },
            );
            assert.equal(result.status, 0);
            events.push('second-end');
            return result;
          },
          { lockPath, label: 'second' },
        );
        await sleep(2200);
        assert.deepEqual(events, ['first-start']);
        events.push('first-end');
      },
      { lockPath, label: 'first' },
    );
    const result = await queued;
    assert.ok(result.gpuQueueMs >= 2000);
    assert.ok(result.gpuExecutionMs < 2000);
    assert.deepEqual(events, ['first-start', 'first-end', 'second-start', 'second-end']);
    await withLocalGpuLease(async () => events.push('third'), { lockPath });
    assert.equal(events.at(-1), 'third');
  } finally {
    await queued?.catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a holder failure cannot admit native work', { timeout: 10000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-local-gpu-failed-'));
  const blocked = join(directory, 'blocked');
  writeFileSync(blocked, 'preserved input');
  let started = false;
  try {
    await assert.rejects(
      withLocalGpuLease(
        async () => {
          started = true;
        },
        { lockPath: join(blocked, 'gpu.lock') },
      ),
      /GPU lease was not acquired/,
    );
    assert.equal(started, false);
    assert.equal(readFileSync(blocked, 'utf8'), 'preserved input');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('cancelling a queued owner never starts its command or disturbs the active lease', {
  skip: process.platform === 'win32',
  timeout: 10000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-local-gpu-'));
  const lockPath = join(directory, 'gpu.lock');
  const started = join(directory, 'started');
  const module = new URL('../local-gpu-lease.mjs', import.meta.url).href;
  let waiter;
  try {
    await withLocalGpuLease(
      async () => {
        waiter = spawn(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `
        import { withLocalGpuLease } from ${JSON.stringify(module)};
        import { writeFileSync } from 'node:fs';
        await withLocalGpuLease(async () => writeFileSync(process.argv[2], 'started'),
          { lockPath: process.argv[1] }).catch(error => console.error(error.message));
      `,
            lockPath,
            started,
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let output = '';
        waiter.stderr.on('data', (chunk) => {
          output += chunk;
        });
        const closed = once(waiter, 'close');
        while (!output.includes('[local-gpu] queued')) await sleep(20);
        waiter.kill('SIGTERM');
        const [code] = await closed;
        assert.equal(code, 143);
        assert.match(output, /wait cancelled by SIGTERM/);
        assert.equal(existsSync(started), false);
        const events = [...output.matchAll(/^\[local-gpu\] (queued|released).* at=(\S+)$/gm)];
        assert.deepEqual(
          events.map((event) => event[1]),
          ['queued', 'released'],
        );
        const timestamps = events.map((event) => Date.parse(event[2]));
        assert.ok(timestamps.every(Number.isFinite), output);
        assert.ok(timestamps[1] >= timestamps[0], output);
      },
      { lockPath },
    );
    await withLocalGpuLease(async () => {}, { lockPath });
  } finally {
    if (waiter?.exitCode === null) waiter.kill('SIGKILL');
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the lease outlives leader exit until TERM-resistant native descendants are reclaimed', {
  skip: process.platform === 'win32',
  timeout: 10000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-local-gpu-'));
  const lockPath = join(directory, 'gpu.lock');
  let queued;
  let descendant;
  try {
    const result = await withLocalGpuLease(
      async () => {
        queued = withLocalGpuLease(
          async () => {
            assert.throws(() => process.kill(descendant, 0), /ESRCH/);
          },
          { lockPath },
        );
        const native = await runBrowserCommand(
          [
            process.execPath,
            '-e',
            `
        const { spawn } = require('node:child_process');
        const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); process.send(process.pid); setInterval(()=>{},1000);"],
          { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        child.once('message', pid => { console.log('descendant='+pid); process.exit(0); });
      `,
          ],
          {
            timeoutMs: 3000,
            timeoutGraceMs: 100,
            env: { ...process.env, GITHUB_ACTIONS: 'false' },
          },
        );
        descendant = Number(native.output.match(/descendant=(\d+)/)?.[1]);
        assert.ok(descendant > 1);
        return native;
      },
      { lockPath },
    );
    assert.equal(result.status, 0);
    assert.equal(result.cleanup.kind, 'sigkill');
    await queued;
  } finally {
    await queued?.catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
});

test('all native roster boundaries opt in while source preparation stays outside the lease', () => {
  for (const name of [
    'run-dawn-gate',
    'run-dawn-partitions',
    'run-direct-light-dawn',
    'run-dawn-smoke-roster',
  ]) {
    const source = readFileSync(new URL(`../${name}.mjs`, import.meta.url), 'utf8');
    assert.match(source, /gpuLease: true/);
  }
  const browser = readFileSync(new URL('../run-split-vitest-browser.mjs', import.meta.url), 'utf8');
  assert.match(browser, /gpuLease: !hostOnly/);
  const gate = readFileSync(new URL('../run-browser-gate-with-retry.mjs', import.meta.url), 'utf8');
  assert.match(gate, /FORGEAX_LOCAL_GPU_LEASE_HELD !== '1'/);
  for (const name of ['run-split-vitest-browser', 'run-dawn-gate']) {
    const source = readFileSync(new URL(`../${name}.mjs`, import.meta.url), 'utf8');
    const preparation = source.slice(
      source.indexOf('const prepared ='),
      source.indexOf('if (prepared.status'),
    );
    assert.doesNotMatch(preparation, /gpuLease/);
  }
});

test('a failed native command preserves its status and frees the lock', {
  timeout: 10000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-local-gpu-'));
  const options = { lockPath: join(directory, 'gpu.lock') };
  try {
    const result = await withLocalGpuLease(
      () =>
        runBrowserCommand([process.execPath, '-e', 'process.exit(7);'], {
          env: { ...process.env, GITHUB_ACTIONS: 'false' },
        }),
      options,
    );
    assert.equal(result.status, 7);
    await assert.rejects(
      withLocalGpuLease(async () => {
        throw new Error('assertion');
      }, options),
      /assertion/,
    );
    let ran = false;
    await withLocalGpuLease(async () => {
      ran = true;
    }, options);
    assert.equal(ran, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('early timer callbacks do not expire a native command before its deadline', () => {
  const commandModule = new URL('../run-browser-gate-with-retry.mjs', import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { runBrowserCommand } from ${JSON.stringify(commandModule)};
    const nativeTimeout = globalThis.setTimeout;
    // Exercise early delivery with real Node children and process-group cleanup.
    globalThis.setTimeout = (callback, delay, ...args) =>
      nativeTimeout(callback, Math.max(1, delay - 20), ...args);
    const result = await runBrowserCommand([
      process.execPath, '-e', 'setInterval(() => {}, 1000)'
    ], { label: 'early-timer probe', timeoutMs: 150, timeoutGraceMs: 10 });
    console.log(JSON.stringify(result));
  `,
    ],
    {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, GITHUB_ACTIONS: 'false' },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(receipt.status, 124);
  assert.equal(receipt.timedOut, true);
  const expiry = /timeout label=early-timer probe pid=\d+ elapsedMs=(\d+) timeoutMs=150;/.exec(
    receipt.output,
  );
  assert.ok(expiry, receipt.output);
  assert.ok(Number(expiry[1]) >= 150, receipt.output);
});

for (const completes of [true, false]) {
  test(completes
    ? 'a native coordinator completes after a private lease queue longer than its deadline'
    : 'a native coordinator retains its execution deadline after private lease acquisition', {
    timeout: 30000,
  }, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'forgeax-local-gpu-coordinator-'));
    const lockPath = join(directory, 'gpu.lock');
    const queuedMarker = join(directory, 'queued');
    const leaseModule = new URL('../local-gpu-lease.mjs', import.meta.url).href;
    const commandModule = new URL('../run-browser-gate-with-retry.mjs', import.meta.url).href;
    const coordinatorMs = 4000;
    const queueHoldMs = 6000;
    const nativeCommand = completes
      ? 'console.log("native started"); setTimeout(() => console.log("native completed"), 100)'
      : 'console.log("native started"); setInterval(() => {}, 1000)';
    let pending;
    try {
      await withLocalGpuLease(
        async () => {
          pending = runBrowserCommand(
            [
              process.execPath,
              '--input-type=module',
              '-e',
              `
                  import { writeFileSync } from 'node:fs';
                  import { withLocalGpuLease } from ${JSON.stringify(leaseModule)};
                  import { runBrowserCommand } from ${JSON.stringify(commandModule)};
                  const pending = withLocalGpuLease(() => runBrowserCommand([
                    process.execPath, '-e', ${JSON.stringify(nativeCommand)}
                  ], { timeoutMs: 20000, timeoutGraceMs: 100 }), {
                    lockPath: ${JSON.stringify(lockPath)}, label: 'nested owner'
                  });
                  // withLocalGpuLease emits queued synchronously before this marker.
                  writeFileSync(${JSON.stringify(queuedMarker)}, 'queued');
                  const result = await pending;
                  process.exitCode = result.status;
                `,
            ],
            {
              label: 'native coordinator',
              timeoutMs: coordinatorMs,
              timeoutGraceMs: 100,
              excludeGpuLeaseQueue: true,
              env: { ...process.env, GITHUB_ACTIONS: 'false' },
            },
          );
          // Start the competing hold after actual queue admission, not spawn.
          const setupDeadline = Date.now() + 10000;
          while (!existsSync(queuedMarker)) {
            if (Date.now() >= setupDeadline) throw new Error('coordinator did not report queued');
            await sleep(25);
          }
          await sleep(queueHoldMs);
        },
        { lockPath, label: 'fixture blocker' },
      );
      const result = await pending;
      await withLocalGpuLease(async () => {}, { lockPath, label: 'cleanup probe' });
      assert.equal(result.status, completes ? 0 : 124, result.output);
      // Distinguish outer expiry from an inner command propagating exit124.
      assert.equal(result.timedOut, !completes, result.output);
      assert.equal(result.cancelled, null, result.output);
      assert.match(result.output, /\[local-gpu\] acquired label=nested owner/);
      assert.match(result.output, /^native started$/m);
      assert.ok(result.excludedGpuQueueMs > coordinatorMs, result.output);
      assert.ok(result.elapsedMs >= queueHoldMs, result.output);
      if (completes) assert.match(result.output, /^native completed$/m);
      else {
        assert.doesNotMatch(result.output, /^native completed$/m);
        // Result timing includes cleanup; the test watchdog bounds total completion.
        const expiry =
          /^\[browser-gate\] timeout label=native coordinator pid=\d+ elapsedMs=(\d+) timeoutMs=(\d+);/m.exec(
            result.output,
          );
        assert.ok(expiry, result.output);
        assert.equal(Number(expiry[2]), coordinatorMs);
        const accountedAtExpiry = Number(expiry[1]) - result.excludedGpuQueueMs;
        assert.ok(accountedAtExpiry >= coordinatorMs, result.output);
        // Bound timer lateness separately from process/stdio cleanup.
        assert.ok(accountedAtExpiry < coordinatorMs + 2000, result.output);
      }
    } finally {
      if (pending) await pending;
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
