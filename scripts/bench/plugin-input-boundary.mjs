#!/usr/bin/env node
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { build, createServer } from 'vite';

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const baseline = resolve(option('--baseline', 'artifacts/plugin-input-boundary/baseline/source'));
const candidate = resolve(option('--candidate', '.'));
const runtimePackages = resolve(option('--runtime-packages', resolve(candidate, 'packages')));
const output = resolve(option('--output', 'artifacts/plugin-input-boundary/comparison.json'));
const rounds = Number(option('--rounds', '7'));
const selectedArm = option('--arm', undefined);
const noiseCases =
  option('--noise', undefined) === undefined ? [0, 1000, 5000] : [Number(option('--noise'))];
const readFile = fs.readFile;
let observation;
fs.readFile = async (...parameters) => {
  const bytes = await readFile(...parameters);
  if (observation && String(parameters[0]).startsWith(`${observation.root}/`)) {
    observation.reads += 1;
    observation.bytes += Buffer.byteLength(bytes);
  }
  return bytes;
};
syncBuiltinESMExports();
const samples = [];
const roots = [];
const servers = [];
const percentile = (values, p) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
try {
  const arms = [];
  for (const [name, sourceRoot] of [
    ['baseline', baseline],
    ['candidate', candidate],
  ]) {
    if (selectedArm && name !== selectedArm) continue;
    const server = await createServer({
      root: sourceRoot,
      configFile: false,
      logLevel: 'silent',
      server: { middlewareMode: true, watch: null },
      appType: 'custom',
    });
    servers.push(server);
    const inputs = await server.ssrLoadModule('/packages/devkit/src/build/plugin-assets.ts');
    const programs = await server.ssrLoadModule('/packages/devkit/src/build/plugin-programs.ts');
    const live = await server.ssrLoadModule('/packages/devkit/src/live-project-inputs.ts');
    const execution = await server.ssrLoadModule('/packages/devkit/src/build/execution-workers.ts');
    arms.push({ name, inputs, programs, live, execution });
  }
  for (const noise of noiseCases) {
    const fixtures = new Map();
    for (const arm of arms) {
      const root = await fs.realpath(await fs.mkdtemp(resolve(tmpdir(), 'fx-input-benchmark-')));
      roots.push(root);
      const write = async (path, text) => {
        const file = resolve(root, path);
        await fs.mkdir(dirname(file), { recursive: true });
        await fs.writeFile(file, text);
      };
      await write(
        'package.json',
        '{"name":"benchmark","type":"module","dependencies":{"@forgeax/engine":"0.0.0"}}',
      );
      await write(
        'forge.json',
        '{"schemaVersion":"3.0.0","id":"benchmark","name":"Benchmark","roots":{}}',
      );
      const authored =
        Array.from(
          { length: 30 },
          (_, i) => `import { value as v${i} } from './part-${i}.ts';`,
        ).join('\n') +
        '\nexport default { apply(ctx) { ctx.value = ' +
        Array.from({ length: 30 }, (_, i) => `v${i}`).join('+') +
        '; } };';
      await write('assets/main.ts', authored);
      for (let i = 0; i < 30; i += 1)
        await write(`assets/part-${i}.ts`, `export const value = ${i};`);
      await write(
        'assets/main.pack.json',
        JSON.stringify({
          schemaVersion: '3.0.0',
          packageId: '01900000-0000-7000-8000-000000000982',
          assets: { main: { kind: 'plugin', payload: { module: { specifier: './main.ts' } } } },
        }),
      );
      await write(
        '.forgeax/bench/main.js',
        "import { createPrograms } from 'virtual:forgeax/plugin-programs/engine'; globalThis.programs = createPrograms('benchmark', 'engine', 1);",
      );
      await fs.mkdir(resolve(root, 'node_modules/@forgeax'), { recursive: true });
      await fs.symlink(
        resolve(runtimePackages, 'engine'),
        resolve(root, 'node_modules/@forgeax/engine'),
        'dir',
      );
      for (let start = 0; start < noise; start += 32)
        await Promise.all(
          Array.from({ length: Math.min(32, noise - start) }, (_, i) =>
            write(`.other-host/state/status-${start + i}.json`, '{"heartbeat":1}'),
          ),
        );
      fixtures.set(arm.name, root);
    }
    for (let round = 0; round <= rounds; round += 1) {
      for (const arm of round % 2 ? [...arms].reverse() : arms) {
        const root = fixtures.get(arm.name);
        observation = { root, reads: 0, bytes: 0 };
        const cpu = process.cpuUsage();
        let begin = performance.now();
        const inventory = await arm.inputs.discoverPluginAssets({ root, assetRoots: ['assets'] });
        const captureMs = performance.now() - begin;
        begin = performance.now();
        await arm.inputs.assertPluginSourceInputs(inventory, root);
        const fenceMs = performance.now() - begin;
        const inputReads = observation.reads,
          inputBytesRead = observation.bytes;
        begin = performance.now();
        await arm.live.readLiveProjectInputs(
          root,
          inventory.sourceSnapshot?.paths ?? [...inventory.sourceInputs.keys()],
        );
        const liveMs = performance.now() - begin;
        const liveReads = observation.reads - inputReads;
        begin = performance.now();
        const result = await build({
          root,
          configFile: false,
          logLevel: 'silent',
          plugins: [
            arm.execution.executionWorkerEntries([]),
            arm.programs.pluginRuntimeProjection(root, inventory.sourceInputs),
            arm.programs.pluginProgramsBuild({
              projectRoot: root,
              roots: { engine: [...inventory.assets.keys()][0] },
              tools: [],
              inventory: async () => inventory,
              binding: { scopeId: 'benchmark' },
              pack: {
                catalogSnapshot: () =>
                  [...inventory.assets.values()].map((record) => ({
                    guid: record.definition.guid,
                    publication: {
                      generation: 1,
                      digest: record.definition.evidence.digest,
                      outputSetDigest: record.definition.evidence.digest,
                    },
                  })),
              },
            }),
          ],
          build: {
            write: false,
            minify: false,
            target: 'esnext',
            rollupOptions: { input: resolve(root, '.forgeax/bench/main.js') },
          },
        });
        if (Array.isArray(result) || !('output' in result))
          throw new Error('missing real Vite output');
        const archive = result.output.find(
          (item) => item.type === 'asset' && item.fileName.endsWith('.programs.json'),
        );
        if (!archive) throw new Error('missing delivered program archive');
        const programs = Object.values(JSON.parse(String(archive.source)).programs);
        if (
          programs.length !== 1 ||
          !Object.values(programs[0].modules).join('\n').includes('ctx.value')
        )
          throw new Error('authored program missing from delivered archive');
        const compileMs = performance.now() - begin;
        const spent = process.cpuUsage(cpu);
        const sample = {
          arm: arm.name,
          noiseFiles: noise,
          round,
          inputCount: inventory.sourceInputs.size,
          captureMs,
          fenceMs,
          liveMs,
          liveReads,
          inputReads,
          inputBytesRead,
          compileMs,
          totalMs: captureMs + fenceMs + liveMs + compileMs,
          cpuMs: (spent.user + spent.system) / 1000,
          rssBytes: process.memoryUsage().rss,
          authoredSha256: inventory.sourceInputs.get(resolve(root, 'assets/main.ts')),
        };
        samples.push(sample);
        process.stdout.write(`${JSON.stringify(sample)}\n`);
        observation = undefined;
      }
    }
  }
  const summary = [];
  for (const noise of noiseCases)
    for (const arm of arms.map((arm) => arm.name)) {
      const measured = samples.filter(
        (sample) => sample.arm === arm && sample.noiseFiles === noise && sample.round > 0,
      );
      const row = {
        arm,
        noiseFiles: noise,
        inputCount: measured[0].inputCount,
        inputReads: measured[0].inputReads,
        inputBytesRead: measured[0].inputBytesRead,
        liveReads: measured[0].liveReads,
      };
      for (const field of ['captureMs', 'fenceMs', 'liveMs', 'compileMs', 'totalMs', 'cpuMs']) {
        row[`${field}P50`] = percentile(
          measured.map((sample) => sample[field]),
          0.5,
        );
        row[`${field}P95`] = percentile(
          measured.map((sample) => sample[field]),
          0.95,
        );
      }
      summary.push(row);
    }
  await fs.mkdir(dirname(output), { recursive: true });
  await fs.writeFile(
    output,
    `${JSON.stringify(
      {
        rounds,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        baseline,
        candidate,
        runtimePackages,
        maxRss: process.resourceUsage().maxRSS,
        scope:
          'Pack discovery, publication fence, accepted live check, real Vite program compilation/archive; no renderer',
        samples,
        summary,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  observation = undefined;
  fs.readFile = readFile;
  syncBuiltinESMExports();
  await Promise.all(servers.map((server) => server.close()));
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
}
