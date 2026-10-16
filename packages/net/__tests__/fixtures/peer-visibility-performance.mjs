import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus, platform, arch, loadavg } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { defineComponent, World } from '@forgeax/engine-ecs';
import { AuthorityCoordinator, defineReplication } from '@forgeax/engine-net';

const root = resolve(import.meta.dirname, '../../../..');
const output = resolve(process.argv[2] ?? 'artifacts/g25');
const base = process.argv[3] ?? '21e3596e81';
const loadAtStart = loadavg();
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('tsup/package.json'))('esbuild');
const temporary = resolve(root, 'packages/net/node_modules/.cache/g25-parent');
mkdirSync(temporary, { recursive: true });
mkdirSync(output, { recursive: true });
const source = execFileSync('git', ['show', `${base}:packages/net/src/replication/authority.ts`], {
  cwd: root,
  encoding: 'utf8',
});
await build({
  stdin: {
    contents: source,
    resolveDir: resolve(root, 'packages/net/src/replication'),
    loader: 'ts',
  },
  outfile: resolve(temporary, 'authority.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['@forgeax/*'],
  plugins: [
    {
      name: 'exact-parent-net',
      setup(build) {
        build.onLoad({ filter: /packages\/net\/src\/.*\.ts$/ }, (args) => ({
          contents: execFileSync('git', ['show', `${base}:${args.path.slice(root.length + 1)}`], {
            cwd: root,
            encoding: 'utf8',
          }),
          loader: 'ts',
        }));
      },
    },
  ],
});
const { AuthorityCoordinator: ParentAuthority } = await import(
  pathToFileURL(resolve(temporary, 'authority.mjs')).href
);
const Tag = defineComponent('PerfVisible', { owner: 'u32' });
const Value = defineComponent('PerfValue', { x: 'f32', y: 'f32', z: 'f32', label: 'string' });
const quantile = (values, q) =>
  [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * q)];
const cases = [];
try {
  for (const entities of [128, 512])
    for (const peers of [1, 8, 32])
      for (const ratio of [1, 0.25, 0.1]) {
        const world = new World();
        const handles = Array.from({ length: entities }, (_, i) =>
          world
            .spawn(
              { component: Tag, data: { owner: i } },
              { component: Value, data: { x: 0, y: i, z: 2, label: `entity-${i}-payload` } },
            )
            .unwrap(),
        );
        const profile = defineReplication({
          name: 'perf',
          entities: { with: [Tag] },
          components: [Tag, Value],
          limits: { maxMessageBytes: 1024 * 1024 },
        }).unwrap();
        const visible = (entity, sessionId) =>
          (world.get(entity, Tag).unwrap().owner + sessionId * 7) % entities <
          Math.ceil(entities * ratio);
        const parent = new ParentAuthority(world, profile);
        const current = new AuthorityCoordinator(world, profile);
        const measure = (mode, tick) => {
          handles.forEach((entity, i) =>
            world
              .set(entity, Value, { x: tick, y: i, z: 2, label: `entity-${i}-payload` })
              .unwrap(),
          );
          const cpuStarted = process.cpuUsage();
          const started = performance.now();
          let bytes = 0;
          if (mode === 'broadcast') bytes = parent.publish().unwrap().bytes.byteLength * peers;
          else
            for (let peer = 1; peer <= peers; peer++)
              bytes += current.publish(peer, visible).unwrap().bytes.byteLength;
          const ms = performance.now() - started;
          const cpu = process.cpuUsage(cpuStarted);
          return { ms, cpuMs: (cpu.user + cpu.system) / 1000, bytes };
        };
        const times = { broadcast: [], filtered: [] };
        const bytes = { broadcast: [], filtered: [] };
        const cpu = { broadcast: [], filtered: [] };
        for (let round = 0; round < 140; round++) {
          // Alternate AB/BA to share scheduler and thermal conditions. Warmup 40.
          const order = round % 2 === 0 ? ['broadcast', 'filtered'] : ['filtered', 'broadcast'];
          for (const mode of order) {
            const sample = measure(mode, round + 1);
            if (round >= 40) {
              times[mode].push(sample.ms);
              bytes[mode].push(sample.bytes);
              cpu[mode].push(sample.cpuMs);
            }
          }
        }
        const result = {
          entities,
          peers,
          ratio,
          samples: 100,
          broadcast: {
            p50Ms: quantile(times.broadcast, 0.5),
            p95Ms: quantile(times.broadcast, 0.95),
            p50CpuMs: quantile(cpu.broadcast, 0.5),
            p95CpuMs: quantile(cpu.broadcast, 0.95),
            bytes: quantile(bytes.broadcast, 0.5),
          },
          filtered: {
            p50Ms: quantile(times.filtered, 0.5),
            p95Ms: quantile(times.filtered, 0.95),
            p50CpuMs: quantile(cpu.filtered, 0.5),
            p95CpuMs: quantile(cpu.filtered, 0.95),
            bytes: quantile(bytes.filtered, 0.5),
          },
        };
        assert(result.filtered.bytes <= result.broadcast.bytes + peers * 8);
        result.raw = { times, cpu, bytes };
        cases.push(result);
        process.stdout.write(
          `${entities} entities / ${peers} peers / ${ratio}: ${result.filtered.p95Ms.toFixed(3)} ms p95, ${result.filtered.bytes} bytes\n`,
        );
      }
  const result = {
    base: execFileSync('git', ['rev-parse', base], { cwd: root, encoding: 'utf8' }).trim(),
    measuredAt: new Date().toISOString(),
    node: process.version,
    platform: `${platform()}-${arch()}`,
    cpu: cpus()[0]?.model,
    loadAtStart,
    loadAtEnd: loadavg(),
    warmup: 40,
    samples: 100,
    pattern:
      'alternating AB/BA; each entity x changes every publication; World writes outside timed interval; encode included; socket/replica excluded',
    cases,
  };
  writeFileSync(resolve(output, 'performance.json'), `${JSON.stringify(result, null, 2)}\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
