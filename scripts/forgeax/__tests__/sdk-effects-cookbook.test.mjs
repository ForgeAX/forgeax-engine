import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
const documentationRoot = resolve(
  process.env.FORGEAX_ENGINE_DOCS_ROOT ?? join(root, '.forgeax-harness/docs/engine'),
);
const references = join(documentationRoot, 'skills/forgeax-engine-sdk/references');
const topicDir = join(references, 'effects');
const topicFiles = readdirSync(topicDir)
  .filter((name) => name.endsWith('.md'))
  .sort();
// The index, every topic file and the pack/gameplay pages that wire them; code samples are
// compiled together as one scene.
const cookbook = [
  readFileSync(join(references, 'effects-cookbook.md'), 'utf8'),
  ...topicFiles.map((name) => readFileSync(join(topicDir, name), 'utf8')),
  readFileSync(join(references, 'content-pack.md'), 'utf8'),
  readFileSync(join(references, 'gameplay-tools.md'), 'utf8'),
].join('\n');
const files = new Map(
  [...cookbook.matchAll(/^```\w+ file=(\S+)\n([\s\S]*?)^```$/gm)].map(
    ([, file = '', source = '']) => [file, source],
  ),
);

test('the cookbook index stays small and links every topic file', () => {
  const index = readFileSync(join(references, 'effects-cookbook.md'), 'utf8');
  expect(Buffer.byteLength(index)).toBeLessThanOrEqual(3 * 1024);
  expect(index).toContain('Open ONLY the topic file you need');
  for (const name of topicFiles) expect(index, name).toContain(`\`${name}\``);
});

test('the effects cookbook compiles as one scene inside the empty template', () => {
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
import { installParticles } from './particles.mjs';
import { fire, smoke } from './particles-fire-smoke.mjs';
import { magic, bubbles, dust } from './particles-magic-dust.mjs';
import { rain, snow } from './particles-rain-snow.mjs';
import { sparks } from './particles-sparks.mjs';

const PARTICLES = { rain, snow, sparks, bubbles, dust, fire, smoke, magic };

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
    const presetFiles = [...files.keys()].filter((file) =>
      /assets\/play\/particles(-[\w-]+)?\.ts$/.test(file),
    );
    expect(presetFiles).toContain('assets/play/particles.ts');
    for (const file of presetFiles) {
      const name = file.replace('assets/play/', '').replace(/\.ts$/, '.mjs');
      const { outputText } = ts.transpileModule(files.get(file) ?? '', {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      });
      writeFileSync(
        join(project, name),
        outputText.replace(/\.\/(particles[\w-]*)\.ts/g, './$1.mjs'),
      );
    }
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

// A Standard Surface keeps Engine lighting. An additive glow mesh that returns its vertex normal and
// full occlusion still adds the sun's Fresnel glare and the sky reflection, so a pillar with zero
// emission rendered solid white against a backlit dusk sky. Glow Surfaces must disable that lighting
// (normal = view direction, occlusion = 0) and must not read the Three.js-oriented uv0.y.
test.each([
  'assets/play/pillar.surface.wgsl',
  'assets/play/beam.surface.wgsl',
])('%s is emission-only and does not catch scene lighting', (file) => {
  const source = files.get(file) ?? '';
  expect(source).not.toBe('');
  // The shared helper is the emission-only contract: black base, normal = view, occlusion 0.
  expect(source).toMatch(/return surfaceEmissionOnly\(input, [^;]*\);/);
  expect(source).not.toMatch(/return SurfaceData\(/);
  expect(source).not.toMatch(/uv0\.y/); // createCylinderGeometry has V=0 at the top
});
