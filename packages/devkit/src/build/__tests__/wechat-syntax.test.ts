// @perf-budget-skip: prepares the ordinary game project and its native build config.
import { cp, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { build } from 'vite';
import { expect, it } from 'vitest';
import { createViteConfig } from '../../host.js';
import { readProjectFacts } from '../../project.js';

it('lowers native bundle syntax without changing BigInt or logical-assignment effects', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-wechat-syntax-'));
  const repository = resolve(import.meta.dirname, '../../../../..');
  try {
    await cp(resolve(repository, 'templates/game-3d'), root, {
      recursive: true,
      filter: (path) => !['node_modules', '.forgeax'].includes(basename(path)),
    });
    await symlink(resolve(repository, 'node_modules'), resolve(root, 'node_modules'), 'dir');
    const facts = await readProjectFacts(root);
    if (!facts.ok) throw facts.error;
    const config = await createViteConfig(facts.value, 'build', './', { target: 'wechat' });
    const target = config.build?.target;
    if (target === undefined) throw new Error('Expected an explicit native syntax target');
    const entry = resolve(root, 'native-syntax.js');
    await writeFile(
      entry,
      `export function exercise() {
        let reads = 0, writes = 0, seeds = 0, current;
        const state = {
          get value() { reads++; return current; },
          set value(value) { writes++; current = value; },
        };
        const seed = () => { seeds++; return 7n; };
        state.value ??= seed();
        state.value ||= seed();
        state.value &&= current + 2n;
        class NativeState {
          #offset = 1n;
          words = new BigInt64Array(1);
          write(value) { this.words[0] = value + this.#offset; }
        }
        const native = new NativeState();
        native.write(current);
        return { reads, writes, seeds, value: native.words[0],
          unsigned: BigInt.asUintN(64, -1n), optional: state?.value ?? 0n };
      }`,
    );
    const result = await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        target,
        write: false,
        rollupOptions: {
          preserveEntrySignatures: 'strict',
          input: entry,
          output: { format: 'cjs' },
        },
      },
    });
    if (Array.isArray(result) || !('output' in result)) throw new Error('Expected one bundle');
    const chunk = result.output.find((item) => item.type === 'chunk');
    if (chunk?.type !== 'chunk') throw new Error('Expected a JavaScript chunk');
    const unsupported: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyDeclaration(node) ||
        ts.isClassStaticBlockDeclaration(node) ||
        ts.isPropertyAccessChain(node) ||
        ts.isElementAccessChain(node) ||
        ts.isCallChain(node) ||
        (ts.isBinaryExpression(node) &&
          [
            ts.SyntaxKind.QuestionQuestionToken,
            ts.SyntaxKind.BarBarEqualsToken,
            ts.SyntaxKind.AmpersandAmpersandEqualsToken,
            ts.SyntaxKind.QuestionQuestionEqualsToken,
          ].includes(node.operatorToken.kind))
      )
        unsupported.push(node.getText());
      ts.forEachChild(node, visit);
    };
    visit(ts.createSourceFile('native-syntax.js', chunk.code, ts.ScriptTarget.Latest, true));
    expect(unsupported).toEqual([]);
    const exports = {} as { exercise(): unknown };
    runInNewContext(chunk.code, { exports });
    expect(exports.exercise()).toEqual({
      reads: 3,
      writes: 2,
      seeds: 1,
      value: 10n,
      unsigned: 18446744073709551615n,
      optional: 9n,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
