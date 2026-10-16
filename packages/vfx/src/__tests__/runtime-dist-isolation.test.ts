import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const vfxRoot = resolve(import.meta.dirname, '..', '..');
const compilerRoot = resolve(vfxRoot, '..', 'vfx-compiler');

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('expected a JSON object');
  return value;
}

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    if (entry === '__tests__') continue;
    const path = resolve(root, entry);
    if (statSync(path).isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (path.endsWith('.ts')) {
      files.push(path);
    }
  }
  return files;
}

function sourceText(root: string): string {
  return sourceFiles(resolve(root, 'src'))
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');
}

function dependencyNames(manifest: unknown): readonly string[] {
  const value = record(manifest);
  const dependencies = value.dependencies;
  return dependencies === undefined ? [] : Object.keys(record(dependencies));
}

function identifiers(source: string): readonly string[] {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) names.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile('entry.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS));
  return [...names];
}

const runtimeForbiddenDependencies = [
  '@forgeax/engine-vfx-compiler',
  '@forgeax/engine-shader-compiler',
  '@forgeax/engine-naga',
  '@forgeax/engine-render',
  '@forgeax/engine-rhi',
];

const compilerForbiddenDependencies = [
  '@forgeax/engine-assets-runtime',
  '@forgeax/engine-ecs',
  '@forgeax/engine-render',
  '@forgeax/engine-rhi',
  '@forgeax/engine-naga',
];

describe('VFX runtime/compiler physical boundary', () => {
  it('distinguishes JavaScript device symbols from comments and shader text', () => {
    expect(identifiers('const shader = `// Renderer computes keys`; // World')).not.toContain(
      'Renderer',
    );
    expect(identifiers('const device = GPUDevice;')).toContain('GPUDevice');
  });
  it('keeps forbidden packages out of both production dependency manifests', () => {
    const runtimeDependencies = dependencyNames(readJson(resolve(vfxRoot, 'package.json')));
    const compilerDependencies = dependencyNames(readJson(resolve(compilerRoot, 'package.json')));

    for (const dependency of runtimeForbiddenDependencies) {
      expect(runtimeDependencies).not.toContain(dependency);
    }
    for (const dependency of compilerForbiddenDependencies) {
      expect(compilerDependencies).not.toContain(dependency);
    }
  });

  it('keeps compiler and device symbols out of the built runtime entry', () => {
    const runtimeDist = readFileSync(resolve(vfxRoot, 'dist', 'index.mjs'), 'utf8');
    const runtimeDeclarations = readFileSync(resolve(vfxRoot, 'dist', 'index.d.ts'), 'utf8');
    const compilerDist = readFileSync(resolve(compilerRoot, 'dist', 'index.mjs'), 'utf8');

    expect(runtimeDist).not.toMatch(/engine-vfx-compiler|shader-compiler|engine-naga/);
    for (const name of ['RenderFeature', 'Renderer', 'RenderGraph', 'GPUDevice', 'RhiDevice'])
      expect(identifiers(runtimeDist)).not.toContain(name);
    expect(runtimeDeclarations).not.toMatch(/engine-vfx-compiler|shader-compiler|engine-naga/);
    expect(compilerDist).not.toMatch(/engine-ecs|engine-render|engine-rhi|engine-naga/);
    for (const name of [
      'World',
      'RenderFeature',
      'Renderer',
      'RenderGraph',
      'GPUDevice',
      'RhiDevice',
    ])
      expect(identifiers(compilerDist)).not.toContain(name);
  });

  it('does not hide the boundary behind a source-level optional import', () => {
    const runtimeSource = sourceText(vfxRoot);
    const compilerSource = sourceText(compilerRoot);

    expect(runtimeSource).not.toMatch(/engine-vfx-compiler|engine-shader-compiler|engine-naga/);
    expect(compilerSource).not.toMatch(/engine-ecs|engine-render|engine-rhi/);
    expect(runtimeSource).not.toMatch(/import\s*\(.*compiler|import\s*\(.*naga/s);
  });
});
