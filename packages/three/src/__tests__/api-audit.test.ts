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
    ['setRenderTarget', 'renderer.setRenderTarget(new WebGLRenderTarget(16, 16));'],
    ['setSize', 'renderer.setSize(16, 16, undefined);'],
    ['setClearColor', "renderer.setClearColor('#000', undefined);"],
  ] as const;
  const source = [
    "import { Group, PerspectiveCamera, WebGLRenderer, WebGLRenderTarget } from '../index';",
    'declare const renderer: WebGLRenderer;',
    'const camera = new PerspectiveCamera();',
    ...calls.map(([, call]) => call),
  ].join('\n');
  const config = ts.readConfigFile(resolve(root, 'tsconfig.test.json'), ts.sys.readFile);
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, language, onError, shouldCreateNewSourceFile) =>
    name === file
      ? ts.createSourceFile(file, source, options.target ?? ts.ScriptTarget.ESNext, true)
      : getSourceFile(name, language, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([file], options, host);
  const rejectedLines = new Set(
    ts
      .getPreEmitDiagnostics(program)
      .filter((diagnostic) => diagnostic.file?.fileName === file)
      .map(
        (diagnostic) => diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line,
      ),
  );
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
  const renderer = report.declarationExports.mismatches.find(
    (entry) => entry.name === 'WebGLRenderer' && entry.reason === 'incompatible-type',
  );
  for (const [index, [member]] of calls.entries())
    expect(renderer?.incompatibleMembers?.includes(member) ?? false, member).toBe(
      rejectedLines.has(index + 3),
    );
});
