import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import ts from 'typescript';
import { expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const template = join(root, 'templates/empty');
const cookbook = readFileSync(
  join(root, 'skills/forgeax-engine-sdk/references/gameplay-cookbook.md'),
  'utf8',
);
const files = new Map(
  [...cookbook.matchAll(/^```\w+ file=(\S+)\n([\s\S]*?)^```$/gm)].map(
    ([, file = '', source = '']) => [file, source],
  ),
);

test('the gameplay cookbook compiles as one game inside the empty template', () => {
  expect([...files.keys()].filter((file) => file.endsWith('.ts')).length).toBeGreaterThan(0);
  const project = mkdtempSync(join(tmpdir(), 'forgeax-cookbook-'));
  try {
    cpSync(template, project, {
      recursive: true,
      filter: (source) => !source.startsWith(join(template, 'node_modules')),
    });
    symlinkSync(join(template, 'node_modules'), join(project, 'node_modules'), 'dir');
    for (const [file, source] of files) {
      mkdirSync(dirname(join(project, file)), { recursive: true });
      writeFileSync(join(project, file), source);
    }
    const config = ts.getParsedCommandLineOfConfigFile(
      join(project, 'tsconfig.json'),
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
          throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
        },
      },
    );
    if (config === undefined) throw new Error('empty template tsconfig did not parse');
    const program = ts.createProgram(config.fileNames, config.options);
    const diagnostics = ts.getPreEmitDiagnostics(program).map((diagnostic) => {
      const where = diagnostic.file?.fileName.replace(`${project}/`, '') ?? 'program';
      return `${where}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`;
    });
    expect(diagnostics).toEqual([]);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, 120_000);

test('the VFX pack references the material and package the TypeScript pack derives', () => {
  const ids = Object.fromEntries(
    [...cookbook.matchAll(/(\w+_PACKAGE) = definePackageId\('([^']+)'\)/g)].map(
      ([, name = '', id = '']) => [name, id],
    ),
  );
  const spark = JSON.parse(files.get('assets/play/spark.pack.json') ?? '{}');
  const play = PackageId.parse(ids.PLAY_PACKAGE ?? '');
  if (!play.ok) throw play.error;
  const material = AssetGuid.format(AssetGuid.derive(play.value, 'material/spark'));
  expect(spark.packageId).toBe(ids.SPARK_PACKAGE);
  expect(spark.assets['vfx/spark'].payload.emitters[0].renderers[0].material).toBe(material);
  expect(spark.assets['vfx/spark'].refs).toEqual([material]);
});

const PARTICLE_DRIVER = `
import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { World } from '@forgeax/engine/ecs';
import { Materials, MeshFilter } from '@forgeax/engine/render';
import { installParticles, PARTICLES } from './particles.mjs';

/** Step every preset through a real World and AssetRegistry; report what the renderer would read. */
export function run() {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const glow = assets.create(Materials.unlit([1, 1, 1, 1])).unwrap();
  const haze = assets.create(Materials.unlit([1, 1, 1, 1])).unwrap();
  let entity;
  const spawn = world.spawn.bind(world);
  world.spawn = (...components) => {
    const spawned = spawn(...components);
    if (spawned.ok) entity = spawned.value;
    return spawned;
  };
  const install = installParticles(world, assets, glow, haze);
  const dispose = install.next().value;
  const emit = install.next().value;
  const report = {};
  for (const [name, preset] of Object.entries(PARTICLES)) {
    const stop = emit(preset, [0, 0, 0]);
    report[name] = { before: undefined, after: undefined, alpha: 0 };
    const read = () => assets.read(world.get(entity, MeshFilter).unwrap().assetHandle).unwrap();
    report[name].before = Array.from(read().attributes.position.slice(0, 3));
    for (let frame = 0; frame < 10; frame++) world.update(1 / 60).unwrap();
    const mesh = read();
    report[name].after = Array.from(mesh.attributes.position.slice(0, 3));
    // Streaks (rain) are Lines over positions only; sprites also carry colour and size.
    const color = mesh.attributes.color ?? new Float32Array([0, 0, 0, 1]);
    report[name].alpha = Math.max(...color.filter((_, i) => i % 4 === 3));
    report[name].topology = mesh.submeshes[0].topology;
    stop();
  }
  const burst = emit(PARTICLES.sparks, [0, 0, 0]);
  for (let frame = 0; frame < 120; frame++) world.update(1 / 60).unwrap();
  report.burstDespawned = !world.componentsOf(entity).ok;
  burst();
  dispose();
  return report;
}
`;

test('the particle recipe moves every preset through real assets and World updates', async () => {
  const project = mkdtempSync(join(tmpdir(), 'forgeax-particles-'));
  try {
    symlinkSync(join(template, 'node_modules'), join(project, 'node_modules'), 'dir');
    writeFileSync(join(project, 'package.json'), '{ "type": "module" }');
    const source = files.get('assets/play/particles.ts') ?? '';
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    writeFileSync(join(project, 'particles.mjs'), outputText);
    writeFileSync(join(project, 'driver.mjs'), PARTICLE_DRIVER);
    const { run } = await import(join(project, 'driver.mjs'));
    const report = run();
    for (const name of ['rain', 'snow', 'sparks', 'bubbles', 'dust', 'fire', 'smoke', 'magic']) {
      expect(report[name]?.after, name).not.toEqual(report[name]?.before);
      expect(report[name]?.alpha, name).toBeGreaterThan(0);
      expect(report[name]?.topology, name).toBe(name === 'rain' ? 'line-list' : 'point-list');
    }
    expect(report.burstDespawned).toBe(true);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, 120_000);
