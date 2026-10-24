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
