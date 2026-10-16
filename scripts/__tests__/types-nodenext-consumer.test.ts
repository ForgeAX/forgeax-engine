import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { test } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

test('published physics and render facades keep candidate and hit fields typed in NodeNext', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-physics-nodenext-'));
  try {
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
    for (const name of ['types', 'ecs', 'rhi', 'physics', 'physics-rapier3d', 'render']) {
      const packageRoot = join(directory, `node_modules/@forgeax/engine-${name}`);
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(
        join(packageRoot, 'package.json'),
        JSON.stringify({
          name: `@forgeax/engine-${name}`,
          type: 'module',
          exports: { '.': { types: './index.d.ts' } },
        }),
      );
      const producer = ts.createProgram([join(root, `packages/${name}/src/index.ts`)], {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        declaration: true,
        emitDeclarationOnly: true,
        skipLibCheck: true,
        rootDir: join(root, `packages/${name}/src`),
        outDir: packageRoot,
        types: [],
      });
      assert.equal(producer.emit().emitSkipped, false);
    }
    const fixture = join(directory, 'consumer.ts');
    writeFileSync(
      fixture,
      `
import { createRapier3DPhysicsWorld } from '@forgeax/engine-physics-rapier3d';
import type { DerivedPhysicsCandidateInput } from '@forgeax/engine-physics';
import type { World } from '@forgeax/engine-ecs';
import type { Handle, MeshAsset } from '@forgeax/engine-types';
declare const world: World;
declare const meshHandle: Handle<'MeshAsset', 'shared'>;
const mesh = world.sharedRefs.resolve<'MeshAsset', MeshAsset>(meshHandle).unwrap();
const slots: readonly string[] = mesh.materialSlots.map(slot => slot.slotName);
// @ts-expect-error A shared reference must retain its requested payload type.
const wrongMesh: string = mesh;
// @ts-expect-error Mesh material slots remain typed through World.sharedRefs.
const wrongSlot: number = mesh.materialSlots[0].slotName;
import { MeshFilter, MeshRenderer, type Renderer } from '@forgeax/engine-render';
declare const renderer: Renderer;
const geometry = renderer.prepareDynamicGeometry(undefined as never).unwrap();
const geometryRevision: number = geometry.revision;
// @ts-expect-error Renderer candidates must retain typed fields through RHI Result.
const wrongGeometryRevision: string = geometry.revision;
const components = [MeshFilter, MeshRenderer];
const physics = createRapier3DPhysicsWorld({});
const hit = physics.raycast(undefined as never, undefined as never, 1);
const distance: number | undefined = hit?.timeOfImpact;
// @ts-expect-error A missing hit field must not silently become any.
hit?.distance;
// @ts-expect-error A valid hit field is numeric.
const wrong: string = hit!.timeOfImpact;
declare const input: DerivedPhysicsCandidateInput;
const candidate = physics.prepareDerivedShapeCandidate(input).unwrap();
const revision: number = candidate.input.revision;
// @ts-expect-error Derived input retains its exact field types.
const wrongRevision: string = candidate.input.revision;
`,
    );
    const consumer = ts.createProgram([fixture], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    });
    assert.deepEqual(
      ts
        .getPreEmitDiagnostics(consumer)
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
      [],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30000);

test('published types barrel retains Result, scope, and VFX exports for NodeNext consumers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-types-nodenext-'));
  try {
    const packageRoot = join(directory, 'node_modules/@forgeax/engine-types');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: '@forgeax/engine-types',
        type: 'module',
        exports: { '.': { types: './index.d.ts' } },
      }),
    );
    // Emit with the producer's Bundler resolution, then check from outside its
    // workspace. Source aliases would hide the consumer's declaration failure.
    const producer = ts.createProgram([join(root, 'packages/types/src/index.ts')], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      declaration: true,
      emitDeclarationOnly: true,
      skipLibCheck: true,
      rootDir: join(root, 'packages/types/src'),
      outDir: packageRoot,
      types: [],
    });
    assert.equal(producer.emit().emitSkipped, false);
    const fixture = join(directory, 'consumer.ts');
    writeFileSync(
      fixture,
      `
import { ok, err, runtimeScopePath, type Result, type RuntimeAssetBinding, type ParticleEffectAsset } from '@forgeax/engine-types';
const value: Result<number, string> = ok(7);
const error: Result<number, string> = err('refused');
const count: number = value.unwrap();
// @ts-expect-error Result must preserve its payload instead of degrading to any.
const wrong: string = value.unwrap();
declare const binding: RuntimeAssetBinding;
const path: string = runtimeScopePath(binding);
declare const effect: ParticleEffectAsset;
const kind: 'particle-effect' = effect.kind;
`,
    );
    const consumer = ts.createProgram([fixture], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    });
    const diagnostics = ts.getPreEmitDiagnostics(consumer);
    assert.deepEqual(
      diagnostics.map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      ),
      [],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
