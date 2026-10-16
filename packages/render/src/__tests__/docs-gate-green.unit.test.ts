import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

function publicPackagePaths(): ts.MapLike<string[]> {
  const paths: ts.MapLike<string[]> = {};
  for (const packageName of [
    '@forgeax/engine-assets-runtime',
    '@forgeax/engine-ecs',
    '@forgeax/engine-geometry',
    '@forgeax/engine-render',
    '@forgeax/engine-scene',
    '@forgeax/engine-types',
  ]) {
    const packageDirectory = packageName.slice('@forgeax/engine-'.length);
    paths[packageName] = [`packages/${packageDirectory}/src/index.ts`];
  }
  return paths;
}

const renderReadme = read('../../README.md');
const assetsReadme = read('../../../assets-runtime/README.md');
const instancesSource = read('../components/instances.ts');
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));

function readWaterConsumerCodeBlock(): string {
  const marker = renderReadme.indexOf('export async function drawProbeLitWater(');
  const blockStart = renderReadme.lastIndexOf('```ts', marker);
  const blockEnd = renderReadme.indexOf('```', marker);
  expect(marker).toBeGreaterThanOrEqual(0);
  expect(blockStart).toBeGreaterThanOrEqual(0);
  expect(blockEnd).toBeGreaterThan(blockStart);
  return renderReadme.slice(blockStart + '```ts'.length, blockEnd);
}

function semanticDiagnosticsFor(sourceText: string): readonly ts.Diagnostic[] {
  const virtualFile = path.join(repositoryRoot, 'packages/render/.docs-gate/water-consumer.ts');
  const options: ts.CompilerOptions = {
    allowImportingTsExtensions: true,
    baseUrl: repositoryRoot,
    ignoreDeprecations: '6.0',
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    paths: publicPackagePaths(),
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    types: ['node'],
  };
  const defaultHost = ts.createCompilerHost(options, true);
  const isVirtualFile = (fileName: string) => path.resolve(fileName) === virtualFile;
  const host: ts.CompilerHost = {
    ...defaultHost,
    fileExists: (fileName) => isVirtualFile(fileName) || defaultHost.fileExists(fileName),
    readFile: (fileName) => (isVirtualFile(fileName) ? sourceText : defaultHost.readFile(fileName)),
    getSourceFile: (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
      isVirtualFile(fileName)
        ? ts.createSourceFile(fileName, sourceText, languageVersion, true, ts.ScriptKind.TS)
        : defaultHost.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile),
  };
  const program = ts.createProgram([virtualFile], options, host);
  const sourceFile = program.getSourceFile(virtualFile);
  expect(sourceFile).toBeDefined();
  return [
    ...program.getOptionsDiagnostics(),
    ...program.getSyntacticDiagnostics(sourceFile),
    ...program.getSemanticDiagnostics(sourceFile),
  ];
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string[] {
  return diagnostics.map((diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
  );
}

describe('M4 material and Instances documentation contract', () => {
  it('semantically checks the complete public water consumer code block', () => {
    const snippet = readWaterConsumerCodeBlock();
    const recovery = snippet.indexOf('const recoverAndRepublish = async');
    expect(recovery).toBeGreaterThanOrEqual(0);
    const diagnostics = semanticDiagnosticsFor(snippet);
    expect(formatDiagnostics(diagnostics)).toEqual([]);
    expect(snippet).not.toContain('renderer.initialization');
    expect(snippet).toContain('const attachment = renderer.attach(world);');
    expect(snippet).toContain('if (!attachment.ok) throw attachment.error;');
    expect(snippet).toContain('const attached = attachment.value;');
    for (const consumer of [
      'renderer.inspect().frame.deviceGeneration',
      'renderer.attach(world)',
      '.draw({',
    ]) {
      expect(snippet.indexOf(consumer)).toBeGreaterThanOrEqual(0);
    }
    for (const recoveryFact of [
      "renderer.state() !== 'device-lost'",
      'await renderer.recover()',
      'page.reconfigureDevice(nextDeviceGeneration)',
      'const previousRanges = ranges',
      'ranges = reserveFreshRanges()',
      'projectionRevision += 1',
      'publishDynamicInput(world.getResource(Time).elapsed)',
      'submitted = await submitAndObserve()',
      'const inspection = renderer.inspect()',
      'submitted.deviceGeneration !== publishedDeviceGeneration',
    ]) {
      expect(snippet.indexOf(recoveryFact, recovery)).toBeGreaterThanOrEqual(recovery);
    }
    expect(snippet).toContain(
      'renderer.setSurfaceDynamicInput({ page, ranges, projectionRevision, frameTime: now })',
    );
    expect(snippet).toContain('retry the same lease after the page and ranges are revalidated');
    expect(snippet).not.toContain('commitUpload(');
    expect(snippet).not.toContain('consume(');
  }, 30_000);

  it('keeps resident observation and derived-bounds recovery discoverable', () => {
    for (const token of [
      'renderer.inspect().meshMaterialBindings[]',
      '`ready`, `pending`, `failed`, or `last-known-good`',
      'nearest structured preparation',
      'does not keep a second readiness ledger',
      '`Instances.transforms` holds packed column-major mat4 values in World-managed',
      'derives CPU union bounds',
      'conservative no-cull result',
      'mesh AABB',
    ]) {
      expect(renderReadme).toContain(token);
    }
    for (const token of [
      'producer lifecycle observations',
      '`inspect -> rebuild/recook or refresh LKG -> loadByGuid`',
      'parallel readiness ledger',
    ]) {
      expect(assetsReadme).toContain(token);
    }
  });

  it('keeps bounds out of the public Instances author schema', () => {
    expect(instancesSource).not.toMatch(/\bbounds\s*:/);
  });
});
