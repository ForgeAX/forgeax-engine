import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import {
  constrainRunnerGpuThreads,
  formatCpuList,
  parseCpuList,
  readAllowedCpuList,
  readCpuPressureDiagnostics,
  resolveRunnerCpuAffinity,
  runnerCpuSiblings,
  runnerGpuThreadAffinity,
  runnerKernelFingerprint,
} from '../run-with-runner-cpu-affinity.mjs';

test('CPU pressure keeps cgroup v2 counters separate from host contention', () => {
  const files = {
    '/sys/fs/cgroup/cpu.stat':
      'usage_usec 12000\nnr_periods 8\nnr_throttled 3\nthrottled_usec 9000\n',
    '/sys/fs/cgroup/cpu.pressure': 'some avg10=25.00 avg60=10.00 avg300=2.00 total=4000\n',
    '/proc/pressure/cpu': 'some avg10=80.00 avg60=50.00 avg300=20.00 total=90000\n',
  };
  assert.deepEqual(readCpuPressureDiagnostics({ read: (path) => files[path] }), {
    cgroupV2Stat: files['/sys/fs/cgroup/cpu.stat'].trim(),
    cgroupPressure: files['/sys/fs/cgroup/cpu.pressure'].trim(),
    hostPressure: files['/proc/pressure/cpu'].trim(),
  });
});

test('CPU pressure preserves cgroup v1 nanosecond counters without mixing units', () => {
  assert.deepEqual(
    readCpuPressureDiagnostics({
      read: (path) =>
        path === '/sys/fs/cgroup/cpu/cpu.stat'
          ? 'nr_periods 8\nnr_throttled 3\nthrottled_time 9000000\n'
          : undefined,
    }),
    { cgroupV1Stat: 'nr_periods 8\nnr_throttled 3\nthrottled_time 9000000' },
  );
});

test('memory pressure keeps shared-host stalls separate from raw cgroup v2 events', () => {
  const files = {
    '/proc/pressure/memory': 'some avg10=75.75 total=90000\nfull avg10=67.42 total=40000\n',
    '/sys/fs/cgroup/memory.pressure': 'some avg10=0.00 total=100\nfull avg10=0.00 total=0\n',
    '/sys/fs/cgroup/memory.current': '499355648\n',
    '/sys/fs/cgroup/memory.peak': '15919607808\n',
    '/sys/fs/cgroup/memory.events': 'low 0\nhigh 0\nmax 8\noom 3\noom_kill 2\n',
  };
  assert.deepEqual(readCpuPressureDiagnostics({ read: (path) => files[path] }), {
    hostMemoryPressure: files['/proc/pressure/memory'].trim(),
    cgroupMemoryPressure: files['/sys/fs/cgroup/memory.pressure'].trim(),
    cgroupV2MemoryCurrent: '499355648',
    cgroupV2MemoryPeak: '15919607808',
    cgroupV2MemoryEvents: files['/sys/fs/cgroup/memory.events'].trim(),
  });
});

test('memory pressure preserves cgroup v1 usage and historical OOM counts without inference', () => {
  const files = {
    '/sys/fs/cgroup/memory/memory.usage_in_bytes': '363806720\n',
    '/sys/fs/cgroup/memory/memory.max_usage_in_bytes': '15919607808\n',
    '/sys/fs/cgroup/memory/memory.oom_control': 'oom_kill_disable 0\nunder_oom 0\noom_kill 12\n',
  };
  assert.deepEqual(readCpuPressureDiagnostics({ read: (path) => files[path] }), {
    cgroupV1MemoryUsage: '363806720',
    cgroupV1MemoryPeak: '15919607808',
    cgroupV1MemoryOom: files['/sys/fs/cgroup/memory/memory.oom_control'].trim(),
  });
});

test('missing or unreadable CPU counters remain unavailable rather than zero', () => {
  for (const read of [
    () => undefined,
    () => '',
    () => {
      throw new Error('not readable');
    },
  ]) {
    assert.equal(readCpuPressureDiagnostics({ read }), null);
  }
});

for (const status of [0, 7]) {
  test(`CPU observation preserves a real child's exit status ${status}`, async () => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('../run-with-runner-cpu-affinity.mjs', import.meta.url)),
        '--',
        process.execPath,
        '-e',
        `process.exitCode = ${status}`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 },
    );
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    const [code, signal] = await once(child, 'close');
    assert.equal(code, status);
    assert.equal(signal, null);
    const samples = output
      .split('\n')
      .filter((line) => line.startsWith('[runner-cpu-pressure] '))
      .map((line) => JSON.parse(line.slice('[runner-cpu-pressure] '.length)));
    assert.deepEqual(
      samples.map((sample) => sample.state),
      readCpuPressureDiagnostics() === null ? [] : ['start', 'complete'],
    );
  });
}

test('GPU discovery follows children of every owned thread without requiring host ps', () => {
  const reads = [];
  const observed = runnerGpuThreadAffinity(10, {
    platform: 'linux',
    selectedCpuList: '56-63',
    list(path) {
      return path === '/proc/10/task' ? ['10', '11'] : ['20'];
    },
    read(path) {
      reads.push(path);
      if (path === '/proc/10/task/11/children') return '20 ';
      if (path.endsWith('/children')) return '';
      if (path === '/proc/20/cmdline') return 'chrome\0--type=gpu-process\0';
      if (path.endsWith('/cmdline')) return 'node\0';
      return 'Name:\tThread<00>\nCpus_allowed_list:\t0-7\n';
    },
  });
  assert.deepEqual(observed, [
    {
      pid: 20,
      threadMasks: [{ cpuList: '0-7', threads: 1, names: ['Thread<00>'], outsideSelected: true }],
    },
  ]);
  assert.ok(reads.every((path) => !path.startsWith('/proc/99/')));
});

test('GPU discovery recognizes rewritten titles and rejects other exact roles', () => {
  for (const [title, expected] of [
    ['chrome --type=gpu-process --no-sandbox\0', [20]],
    ['chrome\0--type=gpu-process\0', [20]],
    ['chrome\0--label=quoted --type=gpu-process\0--type=renderer\0', []],
    ['chrome --type=gpu-process-extra\0', []],
    ['chrome --foo=--type=gpu-process\0', []],
    ['chrome --type=renderer\0', []],
    ['chrome --type=renderer --label=quoted --type=gpu-process\0', []],
    ['chrome --type=gpu-process --type=renderer\0', []],
    ['chrome\0--type=gpu-process\0--type=renderer\0', []],
  ]) {
    const samples = runnerGpuThreadAffinity(10, {
      platform: 'linux',
      list: (path) => [path.split('/')[2]],
      read(path) {
        if (path === '/proc/10/task/10/children') return '20';
        if (path.endsWith('/children')) return '';
        if (path === '/proc/20/cmdline') return title;
        if (path.endsWith('/cmdline')) return 'node\0';
        return 'Name:\tThread<00>\nCpus_allowed_list:\t0-7\n';
      },
    });
    assert.deepEqual(
      samples?.map((sample) => sample.pid),
      expected,
      title,
    );
  }
});

test('GPU affinity observes owned driver threads rather than their parent taskset mask', () => {
  const reads = [];
  const observed = runnerGpuThreadAffinity(10, {
    platform: 'linux',
    selectedCpuList: '56-63',
    list(path) {
      if (path === '/proc/30/task') return ['30', '31', '32'];
      return [path.split('/')[2]];
    },
    read(path) {
      reads.push(path);
      if (path === '/proc/10/task/10/children') return '20';
      if (path === '/proc/20/task/20/children') return '30';
      if (path.endsWith('/children')) return '';
      if (path.endsWith('/cmdline'))
        return path.includes('/30/') ? 'chrome\0--type=gpu-process\0' : 'node\0';
      if (path.includes('/31/')) return 'Name:\tThread<00>\nCpus_allowed_list:\t0-7\n';
      if (path.includes('/32/')) throw new Error('thread exited');
      return 'Name:\tChrome_IOThread\nCpus_allowed_list:\t56-63\n';
    },
  });
  assert.deepEqual(observed, [
    {
      pid: 30,
      threadMasks: [
        { cpuList: '56-63', threads: 1, names: ['Chrome_IOThread'], outsideSelected: false },
        { cpuList: '0-7', threads: 1, names: ['Thread<00>'], outsideSelected: true },
        { cpuList: null, threads: 1, names: [], outsideSelected: null },
      ],
    },
  ]);
  assert.ok(reads.every((path) => !path.startsWith('/proc/99/')));
});

test('missing GPU thread evidence cannot establish CPU isolation', () => {
  assert.equal(runnerGpuThreadAffinity(10, { platform: 'darwin' }), null);
  assert.equal(runnerGpuThreadAffinity(0, { platform: 'linux' }), null);
  assert.equal(
    runnerGpuThreadAffinity(10, {
      platform: 'linux',
      list() {
        throw new Error('proc unavailable');
      },
    }),
    null,
  );
  assert.deepEqual(
    runnerGpuThreadAffinity(10, {
      platform: 'linux',
      list: () => [],
      read() {
        throw new Error('process exited');
      },
    }),
    [],
  );
});

test('Linux samples a real subprocess created by an owned Node Worker', {
  skip: process.platform !== 'linux',
  timeout: 10_000,
}, async () => {
  const worker = new Worker(
    `
    const { spawn } = require('node:child_process');
    const { parentPort } = require('node:worker_threads');
    const child = spawn(process.execPath, ['-e', 'process.title = "chrome --type=gpu-process --no-sandbox"; process.send("ready"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    child.once('message', () => parentPort.postMessage(child.pid));
    parentPort.once('message', () => child.kill('SIGTERM'));
    child.once('exit', () => parentPort.close());
  `,
    { eval: true },
  );
  try {
    const [pid] = await once(worker, 'message');
    const samples = runnerGpuThreadAffinity(process.pid);
    assert.ok(samples?.some((sample) => sample.pid === pid && sample.threadMasks.length > 0));
  } finally {
    const done = once(worker, 'exit');
    worker.postMessage('stop own child');
    await done;
  }
});

test('records actual SMT siblings only for the selected CPUs', () => {
  const paths = [];
  const selected = '8-9,56';
  const topology = runnerCpuSiblings({
    platform: 'linux',
    selectedCpuList: selected,
    read: (path) => {
      paths.push(path);
      return path.includes('cpu9/') ? '9,57\n' : '8,56\n';
    },
  });
  assert.deepEqual(topology, [
    { cpu: 8, siblings: '8,56' },
    { cpu: 9, siblings: '9,57' },
    { cpu: 56, siblings: '8,56' },
  ]);
  assert.deepEqual(
    paths,
    [8, 9, 56].map((cpu) => `/sys/devices/system/cpu/cpu${cpu}/topology/thread_siblings_list`),
  );
});

test('unavailable or inconsistent CPU sibling evidence stays unknown', () => {
  for (const options of [
    {
      platform: 'darwin',
      selectedCpuList: '8',
      read: () => {
        throw new Error('must not read');
      },
    },
    {
      platform: 'linux',
      selectedCpuList: '',
      read: () => {
        throw new Error('must not read');
      },
    },
    {
      platform: 'linux',
      selectedCpuList: '8',
      read: () => {
        throw new Error('unavailable');
      },
    },
    { platform: 'linux', selectedCpuList: '8', read: () => '9,57' },
    { platform: 'linux', selectedCpuList: '8', read: () => 'invalid' },
  ])
    assert.equal(runnerCpuSiblings(options), null);
});

test('parses and formats Linux CPU lists', () => {
  assert.deepEqual(parseCpuList('0-3,8,10-11'), [0, 1, 2, 3, 8, 10, 11]);
  assert.equal(formatCpuList([0, 1, 2, 3, 8, 10, 11]), '0-3,8,10-11');
});

test('rejects malformed CPU lists', () => {
  assert.deepEqual(parseCpuList('0-3,wat'), []);
  assert.deepEqual(parseCpuList('3-1'), []);
});

test('selects the cgroup CPU budget from the process allowed set', () => {
  const result = resolveRunnerCpuAffinity({
    platform: 'linux',
    resources: { cpus: 8, containerized: true },
    allowedCpus: parseCpuList('4-7,12-15'),
    read: () => {
      throw new Error('topology unavailable for logical-window test');
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'taskset');
  assert.equal(result.selectedCpuList, '4-7,12-15');
});

test('uses distinct physical cores when the allowed mask contains SMT siblings', () => {
  const allowedCpus = parseCpuList('0-7');
  const read = (path) => {
    const match = /cpu(\d+)\/topology\/thread_siblings_list$/.exec(path);
    if (!match) throw new Error(`unexpected topology read: ${path}`);
    const cpu = Number(match[1]);
    const firstSibling = Math.floor(cpu / 2) * 2;
    return `${firstSibling}-${firstSibling + 1}\n`;
  };
  const result = resolveRunnerCpuAffinity({
    platform: 'linux',
    resources: { cpus: 4, containerized: true },
    allowedCpus,
    runnerName: 'smt-runner',
    read,
  });
  const selectedCpus = parseCpuList(result.selectedCpuList);
  const selectedTopology = runnerCpuSiblings({
    platform: 'linux',
    selectedCpuList: result.selectedCpuList,
    read,
  });

  assert.equal(result.selectedCpuCount, 4);
  assert.equal(result.selectedCpuTopology, 'distinct-physical-cores');
  assert.equal(selectedCpus.length, 4);
  assert.ok(selectedCpus.every((cpu) => allowedCpus.includes(cpu)));
  assert.equal(new Set(selectedTopology?.map((item) => item.siblings)).size, 4);
});

test('falls back to the logical budget when fewer physical cores are available', () => {
  const read = (path) => {
    const cpu = Number(/cpu(\d+)\/topology\/thread_siblings_list$/.exec(path)?.[1]);
    const firstSibling = Math.floor(cpu / 2) * 2;
    return `${firstSibling}-${firstSibling + 1}\n`;
  };
  const result = resolveRunnerCpuAffinity({
    platform: 'linux',
    resources: { cpus: 4, containerized: true },
    allowedCpus: parseCpuList('0-3'),
    runnerName: 'small-runner',
    read,
  });

  assert.equal(result.selectedCpuList, '0-3');
  assert.equal(result.selectedCpuTopology, 'logical-cpu-window');
});

test('fails closed when the allowed set cannot satisfy the cgroup budget', () => {
  const result = resolveRunnerCpuAffinity({
    platform: 'linux',
    resources: { cpus: 8, containerized: true },
    allowedCpus: parseCpuList('0-3'),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'cpuset-smaller-than-cgroup-quota');
});

test('does not alter a direct host runner', () => {
  const result = resolveRunnerCpuAffinity({
    platform: 'linux',
    resources: { cpus: 8, containerized: false },
    allowedCpus: parseCpuList('0-95'),
  });
  assert.deepEqual(result, {
    ok: true,
    mode: 'none',
    reason: 'host-runner-no-cgroup',
    runnerCpus: 8,
    containerized: false,
    allowedCpuCount: 96,
    allowedCpuList: '0-95',
  });
});

test('quota-only shared runners retain kernel placement instead of colliding on a hash window', () => {
  for (const runnerName of ['quota-runner-a', 'quota-runner-b']) {
    const result = resolveRunnerCpuAffinity({
      platform: 'linux',
      resources: { cpus: 8, containerized: true },
      allowedCpus: parseCpuList('0-95'),
      runnerName,
      read: (path) => /cpu(\d+)\/topology/.exec(path)?.[1] ?? '',
    });
    assert.equal(result.mode, 'none');
    assert.equal(result.reason, 'shared-cpu-set-with-quota');
    assert.equal(result.runnerCpus, 8, 'the cgroup budget remains authoritative');
    assert.equal(result.allowedCpuList, '0-95');
    assert.equal(result.selectedCpuList, undefined);
  }
});

test('sparse shared masks retain scheduler placement when topology is unavailable', () => {
  const allowedCpus = parseCpuList('4-7,12-15,32-35,48-51');
  const result = resolveRunnerCpuAffinity({
    platform: 'linux',
    resources: { cpus: 4, containerized: true },
    allowedCpus,
    read: () => {
      throw new Error('topology unavailable');
    },
  });
  assert.equal(result.mode, 'none');
  assert.equal(result.allowedCpuList, '4-7,12-15,32-35,48-51');
  assert.equal(result.selectedCpuList, undefined);
});

test('kernel correlation is opaque, stable, and optional without changing admission', () => {
  const first = runnerKernelFingerprint({ platform: 'linux', read: () => 'kernel-a\n' });
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, runnerKernelFingerprint({ platform: 'linux', read: () => 'kernel-a' }));
  assert.notEqual(first, runnerKernelFingerprint({ platform: 'linux', read: () => 'kernel-b' }));
  assert.equal(runnerKernelFingerprint({ platform: 'linux', read: () => '' }), null);
  assert.equal(
    runnerKernelFingerprint({
      platform: 'linux',
      read: () => {
        throw new Error('denied');
      },
    }),
    null,
  );
  assert.equal(
    runnerKernelFingerprint({
      platform: 'darwin',
      read: () => {
        throw new Error('must not read');
      },
    }),
    null,
  );
});

function escapedGpuFixture({ reused = false, detached = false } = {}) {
  let generationReads = 0;
  let scopeReads = 0;
  return {
    platform: 'linux',
    selectedCpuList: '80-87',
    list: (path) => (path === '/proc/20/task' ? ['20', '21', '22'] : ['10']),
    read(path) {
      if (path === '/proc/10/task/10/children') return detached && scopeReads++ ? '' : '20';
      if (path.endsWith('/children')) return '';
      if (path.endsWith('/cmdline'))
        return path.includes('/20/') ? 'chrome\0--type=gpu-process\0' : 'node\0';
      if (path.endsWith('/stat')) {
        const generation = path === '/proc/20/stat' && reused && generationReads++ ? 101 : 100;
        return `20 (chrome gpu) S ${Array(18).fill('0').join(' ')} ${generation}`;
      }
      const escaped = path.includes('/21/');
      return `Name:\tThread<00>\nTgid:\t20\nCpus_allowed_list:\t${escaped ? '0-7' : '80-87'}\n`;
    },
  };
}

test('constrains only escaped owned GPU threads without a 64-bit mask limit', () => {
  const calls = [];
  const result = constrainRunnerGpuThreads(10, {
    ...escapedGpuFixture(),
    bind: (tid, cpus) => calls.push([tid, cpus]),
  });
  assert.deepEqual(calls, [[21, '80-87']]);
  assert.deepEqual(result, { corrected: 1, errors: [] });
});

test('does not bind a reused or detached GPU process', () => {
  for (const options of [{ reused: true }, { detached: true }]) {
    const calls = [];
    const result = constrainRunnerGpuThreads(10, {
      ...escapedGpuFixture(options),
      bind: (...args) => calls.push(args),
    });
    assert.deepEqual(calls, []);
    assert.deepEqual(result, { corrected: 0, errors: [] });
  }
});

test('retains affinity errors and ignores only a naturally exited owned thread', () => {
  for (const code of ['ESRCH', 'EPERM']) {
    const result = constrainRunnerGpuThreads(10, {
      ...escapedGpuFixture(),
      bind() {
        throw Object.assign(new Error('bind failed'), { code });
      },
    });
    assert.equal(result.corrected, 0);
    assert.equal(result.errors.length, code === 'ESRCH' ? 0 : 1);
  }
});

test('Linux corrects an actual owned subprocess escaping its inherited mask', {
  skip: process.platform !== 'linux',
  timeout: 10_000,
}, async (context) => {
  const allowed = readAllowedCpuList();
  if (allowed.length < 2) return context.skip('requires two allowed CPUs');
  const selected = String(allowed.at(-1));
  const escaped = String(allowed[0]);
  const child = spawn(
    'taskset',
    [
      '--cpu-list',
      selected,
      process.execPath,
      '-e',
      `
    require('node:child_process').execFileSync('taskset', ['--pid', '--cpu-list', '${escaped}', String(process.pid)]);
    process.title = 'chrome --type=gpu-process';
    process.send('ready');
    setInterval(() => {}, 1000);
  `,
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  try {
    await once(child, 'message');
    const before = runnerGpuThreadAffinity(child.pid, { selectedCpuList: selected });
    assert.ok(
      before.find((gpu) => gpu.pid === child.pid)?.threadMasks.some((mask) => mask.outsideSelected),
    );
    const corrected = constrainRunnerGpuThreads(child.pid, { selectedCpuList: selected });
    assert.ok(corrected.corrected > 0);
    assert.deepEqual(corrected.errors, []);
    const after = runnerGpuThreadAffinity(child.pid, { selectedCpuList: selected });
    assert.ok(
      after
        .find((gpu) => gpu.pid === child.pid)
        ?.threadMasks.every((mask) => mask.outsideSelected === false),
    );
  } finally {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
});

test('does not constrain unknown ownership or a non-bound platform', () => {
  for (const variant of ['wrong-tgid', 'darwin', 'empty-mask']) {
    const fixture = escapedGpuFixture();
    const read = fixture.read;
    const calls = [];
    const result = constrainRunnerGpuThreads(10, {
      ...fixture,
      platform: variant === 'darwin' ? 'darwin' : 'linux',
      selectedCpuList: variant === 'empty-mask' ? '' : fixture.selectedCpuList,
      read: (path) =>
        variant === 'wrong-tgid' && path.endsWith('/status')
          ? read(path).replace('Tgid:\t20', 'Tgid:\t99')
          : read(path),
      bind: (...args) => calls.push(args),
    });
    assert.deepEqual(calls, []);
    assert.deepEqual(result, { corrected: 0, errors: [] });
  }
});

test('retired GPU TIDs cannot bind a recycled foreign task after process validation', () => {
  let processReads = 0;
  let retired = false;
  const calls = [];
  const fixture = escapedGpuFixture();
  const read = fixture.read;
  const result = constrainRunnerGpuThreads(10, {
    ...fixture,
    read(path) {
      if (path === '/proc/20/stat' && ++processReads >= 2) retired = true;
      if (path.startsWith('/proc/20/task/21/') && retired) {
        throw Object.assign(new Error('owned thread exited'), { code: 'ENOENT' });
      }
      return read(path);
    },
    bind: (tid) => calls.push({ tid, currentTgid: retired ? 21 : 20 }),
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(result, { corrected: 0, errors: [] });
});

test('a worker replaced inside the same GPU process is not bound from its stale identity', () => {
  let threadReads = 0;
  const calls = [];
  const fixture = escapedGpuFixture();
  const read = fixture.read;
  const result = constrainRunnerGpuThreads(10, {
    ...fixture,
    read(path) {
      if (path === '/proc/20/task/21/stat') {
        return read(path).replace(/100$/, String(++threadReads === 1 ? 100 : 101));
      }
      return read(path);
    },
    bind: (...args) => calls.push(args),
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(result, { corrected: 0, errors: [] });
});
