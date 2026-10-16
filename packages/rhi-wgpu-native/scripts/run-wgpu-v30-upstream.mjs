#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const expectedCommit = '40f4a34ebaf56f9a046231f54125ad046239d3f3';
const checkout = resolve(process.env.FORGEAX_WGPU_V30_CHECKOUT ?? process.argv[2] ?? 'references/wgpu-v30');
const outputDirectory = resolve(
  process.env.FORGEAX_WGPU_UPSTREAM_REPORT ?? process.argv[3] ?? 'report/native-ray-query-upstream',
);

function command(program, commandArguments, name, accepts) {
  const result = spawnSync(program, commandArguments, {
    cwd: checkout,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CARGO_TERM_COLOR: 'never' },
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  writeFileSync(resolve(outputDirectory, `${name}.log`), output);
  const cases = output
    .split('\n')
    .map((line) => line.match(/\b(PASS|FAIL|TIMEOUT|ABORT|LEAK)\s+\[[^\]]+\]\s+\(\s*\d+\/\d+\)\s+(.+)$/))
    .filter(Boolean)
    .map((match) => ({
      name: match[2],
      status: match[2].includes('[Unsupported:') ? 'unsupported' : match[1] === 'PASS' ? 'pass' : 'fail',
    }))
    .filter(({ name: testName }) => accepts(testName));
  return {
    name,
    command: [program, ...commandArguments],
    exitCode: result.status,
    cases,
    passed:
      result.status === 0 &&
      cases.some(({ status }) => status === 'pass') &&
      cases.every(({ status }) => status !== 'fail'),
  };
}

mkdirSync(outputDirectory, { recursive: true });
const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).stdout.trim();
if (commit !== expectedCommit) {
  throw new Error(`wgpu v30 checkout is ${commit || 'unreadable'}, expected ${expectedCommit}`);
}
for (const tool of ['cargo-nextest', 'spirv-as', 'spirv-cross']) {
  const available = spawnSync(tool, ['--version'], { encoding: 'utf8' });
  if (available.error?.code === 'ENOENT') {
    throw new Error(`${tool} is required by the pinned upstream suite`);
  }
}

const suites = [
  command(
    'cargo',
    ['xtask', 'test', '--test', 'wgpu-gpu', '-E', 'test(/wgpu_gpu::ray_tracing::/)', '--test-threads', '1'],
    'wgpu-gpu-ray-tracing',
    (name) => name.includes('wgpu_gpu::ray_tracing::'),
  ),
  command(
    'cargo',
    ['xtask', 'test', '-E', 'package(wgpu-examples) and test(/ray_/)', '--test-threads', '1'],
    'wgpu-ray-tracing-examples',
    (name) => /\] ray_/.test(name),
  ),
  command(
    'cargo',
    [
      'nextest',
      'run',
      '--package',
      'naga',
      '--test',
      'naga',
      '-E',
      'test(/snapshots::convert_snapshots_(wgsl|spv)/) or test(wgsl_errors::ray_query_vertex_return_enable_extension)',
      '--test-threads',
      '1',
    ],
    'naga-ray-query',
    (name) => name.includes('snapshots::convert_snapshots_') || name.includes('ray_query_vertex_return'),
  ),
];
const report = {
  schemaVersion: 1,
  wgpuVersion: '30.0.1',
  wgpuTag: 'v30.0.1',
  wgpuTagCommit: commit,
  wgpuSourceCommit: commit,
  suites,
};
const reportPath = resolve(outputDirectory, 'upstream-report.json');
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${reportPath}\n`);
if (suites.some(({ passed }) => !passed)) process.exitCode = 1;
