import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('agrees with actual caller diagnostics, including optional and defaulted arguments', {
  timeout: 30000,
}, async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const file = resolve(root, 'src/__tests__/audit-consumer.ts');
  const calls = [
    ['render', 'renderer.render(new Group(), camera);'],
    ['setRenderTarget', 'renderer.setRenderTarget(new RenderTarget(16, 16));'],
    ['setSize', 'renderer.setSize(16, 16, undefined);'],
    ['setClearColor', "renderer.setClearColor('#000', undefined);"],
  ] as const;
  const source = [
    "import { Group, PerspectiveCamera, WebGPURenderer, RenderTarget, QuadMesh, MeshBasicMaterial } from '../index';",
    'declare const renderer: WebGPURenderer;',
    'const camera = new PerspectiveCamera();',
    ...calls.map(([, call]) => call),
    "const quad: import('three/src/renderers/common/QuadMesh.js').default = new QuadMesh(new MeshBasicMaterial());",
    "quad.addEventListener('dispose', (event) => { const target: typeof quad = event.target; void target; });",
    "new (requireStackTrace())(new Error('invalid upstream input'));",
    "function requireStackTrace() { return undefined as unknown as typeof import('../index').StackTrace; }",
  ].join('\n');
  const config = ts.readConfigFile(resolve(root, 'tsconfig.test.json'), ts.sys.readFile);
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, language, onError, shouldCreateNewSourceFile) =>
    resolve(name) === file
      ? ts.createSourceFile(file, source, options.target ?? ts.ScriptTarget.ESNext, true)
      : getSourceFile(name, language, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([file], options, host);
  const rejectedLines = new Set(
    ts
      .getPreEmitDiagnostics(program)
      .filter(
        (diagnostic) => diagnostic.file !== undefined && resolve(diagnostic.file.fileName) === file,
      )
      .map(
        (diagnostic) => diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line,
      ),
  );
  expect(rejectedLines.has(calls.length + 3)).toBe(false);
  expect(rejectedLines.has(calls.length + 4)).toBe(false);
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [resolve(root, 'scripts/audit-api.mjs')],
    { cwd: dirname(root), maxBuffer: 1024 * 1024 },
  );
  const report = JSON.parse(stdout) as {
    declarationExports: {
      mismatches: { name: string; reason: string; incompatibleMembers?: string[] }[];
    };
  };
  expect(rejectedLines.has(calls.length + 5)).toBe(true);
  expect(
    report.declarationExports.mismatches.some(
      (entry) =>
        entry.name === 'StackTrace' &&
        entry.reason === 'incompatible-constructor-or-static-members',
    ),
  ).toBe(true);
  const renderer = report.declarationExports.mismatches.find(
    (entry) => entry.name === 'WebGPURenderer' && entry.reason === 'incompatible-type',
  );
  for (const [index, [member]] of calls.entries())
    expect(renderer?.incompatibleMembers?.includes(member) ?? false, member).toBe(
      rejectedLines.has(index + 3),
    );
});
