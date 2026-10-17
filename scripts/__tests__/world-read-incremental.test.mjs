import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

const ecs = new URL('../../packages/ecs/src/', import.meta.url);
const readSource = readFileSync(new URL('world-read.ts', ecs), 'utf8');
const augmentation = readFileSync(new URL('world-internal-augmentation.d.ts', ecs), 'utf8');
const worldSource = readFileSync(new URL('world.ts', ecs), 'utf8');
const worldTree = ts.createSourceFile('world.ts', worldSource, ts.ScriptTarget.ES2022, true);
const worldClass = worldTree.statements.find(
  (node) => ts.isClassDeclaration(node) && node.name?.text === 'World',
);
const readDeclaration = worldClass.members.find(
  (node) => ts.isPropertyDeclaration(node) && node.name.getText(worldTree) === '[worldRead]',
);
assert.ok(
  readDeclaration?.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword),
  'The public World capability must retain its readonly declaration.',
);
const readAssignments = worldClass.members
  .find(ts.isConstructorDeclaration)
  .body.statements.filter(
    (node) =>
      ts.isExpressionStatement(node) &&
      ts.isBinaryExpression(node.expression) &&
      node.expression.left.getText(worldTree) === 'this[worldRead]',
  );
const printer = ts.createPrinter();
function capabilitySource(node, changed) {
  const transformed = ts.transform(node, [
    (context) => {
      const visit = (child) => {
        if (!changed && ts.isObjectLiteralExpression(child)) {
          return ts.factory.updateObjectLiteralExpression(
            child,
            child.properties.filter(
              (property) => property.name?.getText(worldTree) !== 'getRelationshipEpoch',
            ),
          );
        }
        return ts.visitEachChild(child, visit, context);
      };
      return (root) => ts.visitNode(root, visit);
    },
  ]);
  try {
    return printer.printNode(ts.EmitHint.Unspecified, transformed.transformed[0], worldTree);
  } finally {
    transformed.dispose();
  }
}
const withoutRead = (source) =>
  source
    .replace(/^import .* from '\.\/world-read';\n/m, '')
    .replace(/^ {4}(?:readonly )?\[worldRead\]: WorldRead;\n/m, '');

function compileSequence(fixed) {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-world-read-incremental-'));
  try {
    const src = join(root, 'src');
    mkdirSync(src);
    const options = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      skipLibCheck: true,
      composite: true,
      incremental: true,
      declaration: true,
      emitDeclarationOnly: true,
      rootDir: src,
      outDir: join(root, 'dist'),
      tsBuildInfoFile: join(root, 'dist/.tsbuildinfo'),
      types: [],
    };
    writeFileSync(
      join(src, 'component.ts'),
      "import type { World } from './world'; export interface Component { name: string; owner?: World } export const componentId = (_component: Component): number => 0;",
    );
    writeFileSync(join(src, 'entity-handle.ts'), 'export type EntityHandle = number;');
    writeFileSync(
      join(src, 'world-internal.ts'),
      `export const worldInternal: unique symbol = Symbol.for('internal');
export interface WorldInternal { value: number; getRelationshipEpoch: (component: import('./component').Component) => number }`,
    );
    const rootNames = [
      'component.ts',
      'entity-handle.ts',
      'world-read.ts',
      'world-internal.ts',
      'world.ts',
      'world-internal-augmentation.d.ts',
      'consumer.ts',
    ].map((file) => join(src, file));
    const steps = [];
    for (const changed of [false, true, true]) {
      writeFileSync(
        join(src, 'world-read.ts'),
        changed ? readSource : readSource.replace(/^ {2}readonly getRelationshipEpoch: .*\n/m, ''),
      );
      writeFileSync(
        join(src, 'world-internal-augmentation.d.ts'),
        changed && fixed ? augmentation : withoutRead(augmentation),
      );
      writeFileSync(
        join(src, 'world.ts'),
        `import { worldRead, type WorldRead } from './world-read';
import { worldInternal } from './world-internal';
import { componentId } from './component';
export class World {
  ${capabilitySource(readDeclaration, changed)}
  private readonly relationshipIndexes = new Map<number, { epoch: number }>();
  private internalgetFieldValue() { return undefined; }
  private internalgetArrayLength() { return undefined; }
  private internalgetArrayElement() { return undefined; }
  constructor() {
    this[worldInternal] = { value: 1, getRelationshipEpoch: () => 1 };
    ${readAssignments.map((node) => capabilitySource(node, changed)).join('\n')}
  }
}`,
      );
      writeFileSync(
        join(src, 'consumer.ts'),
        `import { World } from './world';
import { worldRead } from './world-read';
const reader = new World()[worldRead];
reader.getFieldValue(0, { name: 'Pair' }, 'target');
${changed ? "reader.getRelationshipEpoch({ name: 'Pair' });" : ''}`,
      );
      const builder = ts.createIncrementalProgram({ rootNames, options });
      steps.push(builder.getSemanticDiagnostics().map((diagnostic) => diagnostic.code));
      assert.equal(builder.emit().emitSkipped, false);
    }
    if (fixed) {
      // This consumes the emitted declaration, with no source alias or source
      // augmentation. The source initialization seam must not widen the SDK.
      const consumer = join(root, 'published-consumer.ts');
      writeFileSync(
        consumer,
        `import { World } from './dist/world';
import { worldRead } from './dist/world-read';
const world = new World();
world[worldRead] = world[worldRead];`,
      );
      const program = ts.createProgram([consumer], {
        ...options,
        composite: false,
        incremental: false,
        declaration: false,
        emitDeclarationOnly: false,
        noEmit: true,
        rootDir: root,
        tsBuildInfoFile: undefined,
      });
      assert.deepEqual(
        ts.getPreEmitDiagnostics(program).map((diagnostic) => diagnostic.code),
        [2540],
        'The public declaration must reject replacement of the readonly capability.',
      );
    }
    return steps;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('source capability merge survives incremental WorldRead growth without widening declarations', () => {
  assert.deepEqual(compileSequence(true), [[], [], []]);
});

test('removing the capability merge reproduces the incremental computed-symbol failure', () => {
  const [baseline, changed, repeated] = compileSequence(false);
  assert.deepEqual(baseline, []);
  assert.ok(changed.length > 0);
  assert.ok(changed.every((code) => code === 7053));
  assert.deepEqual(repeated, changed);
});
