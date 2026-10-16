// structural.test.ts — w6: Structural verification (AC-01/02/05/06)
//
// Post-implementation verification of the built package:
// AC-01: package directory + package.json name
// AC-02: four exports accessible + GameProject is z.infer-derived
// AC-05: zod in dependencies, z.infer used
// AC-06: no node:fs / fetch imports in source

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// ── AC-01: package directory exists + package.json name ─────────────────────
describe('AC-01: package directory', () => {
  it('package directory exists at packages/project/', () => {
    const pkgDir = path.resolve(import.meta.dirname, '..', '..');
    expect(fs.existsSync(pkgDir)).toBe(true);

    const pkgJsonPath = path.join(pkgDir, 'package.json');
    expect(fs.existsSync(pkgJsonPath)).toBe(true);

    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
    expect(pkg.name).toBe('@forgeax/engine-project');
  });

  it('keeps the public package exports stable after the directory move', () => {
    const pkgDir = path.resolve(import.meta.dirname, '..', '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf-8'));
    expect(pkg.exports).toEqual({
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.mjs',
      },
      './package.json': './package.json',
    });
  });
});

// ── AC-02: four exports accessible ──────────────────────────────────────────
describe('AC-02: exports accessible', () => {
  it('loadGameProject is importable', async () => {
    const mod = await import('../index.js');
    expect(mod.loadGameProject).toBeDefined();
    expect(typeof mod.loadGameProject).toBe('function');
  });

  it('GameProjectSchema is importable', async () => {
    const mod = await import('../index.js');
    expect(mod.GameProjectSchema).toBeDefined();
  });

  it('FORGE_JSON is importable', async () => {
    const mod = await import('../index.js');
    expect(mod.FORGE_JSON).toBe('forge.json');
  });

  it('GameProject type is derived from z.infer', async () => {
    // Import the schema and check that GameProject is a z.infer type.
    // At runtime z.infer produces nothing, but we can verify the schema exists
    // and that the type declaration compiles (verified by typecheck step).
    const mod = await import('../index.js');
    expect(mod.GameProjectSchema).toBeDefined();
    // We can create a valid object and parse it using the schema
    const result = mod.GameProjectSchema.safeParse({
      id: 'test',
      name: 'Test',
      schemaVersion: '3.0.0',
      roots: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // GameProject type fields are inferrable — this object has id/name/schemaVersion
      const gp = result.data;
      expect(gp.id).toBe('test');
      expect(gp.name).toBe('Test');
      expect(gp.schemaVersion).toBe('3.0.0');
    }
  });

  it('exposes the root schema', async () => {
    const mod = await import('../index.js');
    expect(mod.GameProjectRootsSchema).toBeDefined();
    expect(mod.GameProjectRootsSchema.parse({})).toEqual({});
  });

  it('keeps the validation primitive owner-local', async () => {
    const mod = await import('../index.js');
    expect('validateGameProject' in mod).toBe(false);
  });

  it('GameProjectError is importable', async () => {
    const mod = await import('../index.js');
    expect(mod.GameProjectError).toBeDefined();
  });
});

// ── AC-05: zod in dependencies, z.infer used ────────────────────────────────
describe('AC-05: zod dependency', () => {
  it('package.json deps includes zod', () => {
    const pkgDir = path.resolve(import.meta.dirname, '..', '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf-8'));
    expect(pkg.dependencies).toBeDefined();
    expect(pkg.dependencies.zod).toBeDefined();
  });

  it('schema.ts imports zod and uses z.infer', () => {
    const schemaPath = path.resolve(import.meta.dirname, '..', 'schema.ts');
    const content = fs.readFileSync(schemaPath, 'utf-8');
    expect(content).toContain("from 'zod'");
    expect(content).toContain('z.infer');
  });
});

// ── AC-06: no node:fs / fetch in engine-project src/ ────────────────────────
describe('AC-06: no node:fs / fetch imports in source', () => {
  const srcDir = path.resolve(import.meta.dirname, '..');

  function grepForbiddenImports(filePath: string): string[] {
    const content = fs.readFileSync(filePath, 'utf-8');
    const hits: string[] = [];

    // Only check actual imports, not comments
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
        continue;
      }
      if (
        trimmed.includes("from 'node:fs'") ||
        trimmed.includes('from "node:fs"') ||
        trimmed.includes("from 'fs'") ||
        trimmed.includes('from "fs"') ||
        trimmed.includes('import fs ') ||
        trimmed.includes('import * as fs ') ||
        trimmed.includes("require('fs'") ||
        trimmed.includes('require("fs"') ||
        trimmed.includes("from 'node:path'") ||
        trimmed.includes('from "node:path"') ||
        trimmed.includes('globalThis.fetch') ||
        trimmed.includes('window.fetch')
      ) {
        hits.push(line);
      }
    }

    // Also check for fetch() calls that aren't from injection
    const fetchCallPattern = /\bfetch\s*\(/;
    if (fetchCallPattern.test(content)) {
      hits.push('contains fetch() call');
    }

    return hits;
  }

  it('source files have no node:fs imports', () => {
    const entries = fs.readdirSync(srcDir, { recursive: true });
    const files: string[] = [];
    for (const entry of entries) {
      if (
        typeof entry === 'string' &&
        entry.endsWith('.ts') &&
        !entry.includes('__tests__') &&
        !entry.includes('.test.')
      ) {
        files.push(path.join(srcDir, entry));
      }
    }

    for (const file of files) {
      const hits = grepForbiddenImports(file);
      expect(
        hits,
        `${path.relative(srcDir, file)} has forbidden imports: ${hits.join(', ')}`,
      ).toHaveLength(0);
    }
  });

  it('loader.ts uses injection-only read (no fetch/fs)', () => {
    const loaderPath = path.resolve(import.meta.dirname, '..', 'loader.ts');
    const content = fs.readFileSync(loaderPath, 'utf-8');
    // loader.ts should accept (read) as parameter — no direct fs/fetch import
    expect(content).not.toMatch(/import\s+.*from\s+['"]node:fs['"]/);
    expect(content).not.toMatch(/import\s+.*from\s+['"]fs['"]/);
    // The read injection signature: `read: (path: string) => Promise<string>`
    expect(content).toContain('read: (path: string) => Promise<string>');
  });
});
