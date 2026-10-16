#!/usr/bin/env node

// Tests for scripts/lint-internal.mjs.
//
// Covers the ts-morph powered checks for D-internal naming/JSDoc coupling.
// The script enforces four rules (R-internal-A is owned by Biome
// useNamingConvention, NOT this script):
//
//   R-internal-B: class private/protected member name starts with _ but
//                 lacks /** @internal */ JSDoc -> error.
//   R-internal-C: class private/protected member has @internal but does
//                 not start with _ -> error.
//   R-internal-D: module-level `let _xxx` lacks @internal on its
//                 VariableStatement -> error.
//   R-internal-E: interface/type member starts with _ but lacks @internal
//                 (field-level; no cascade from the interface declaration).
//
// The fixture builds in-memory ts-morph SourceFiles via Project +
// createSourceFile and invokes the script's `lintProjectSource` helper to
// assert error counts and human-readable messages.

import { Project, ScriptTarget } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { lintProjectSource } from '../lint-internal.mjs';

function makeProject() {
  return new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { target: ScriptTarget.ESNext, strict: true },
  });
}

describe('lint-internal R-internal-B (class member _ prefix without @internal)', () => {
  it('flags private _foo lacking @internal', () => {
    const project = makeProject();
    project.createSourceFile(
      'a.ts',
      `export class C { private _foo = 0; method(): number { return this._foo; } }\n`,
    );
    const errors = lintProjectSource(project);
    expect(errors).toHaveLength(1);
    expect(errors[0].rule).toBe('R-internal-B');
    expect(errors[0].name).toBe('_foo');
  });

  it('passes private _foo with /** @internal */', () => {
    const project = makeProject();
    project.createSourceFile(
      'b.ts',
      `export class C {\n  /** @internal */\n  private _foo = 0;\n}\n`,
    );
    const errors = lintProjectSource(project);
    expect(errors.filter((e) => e.rule === 'R-internal-B')).toHaveLength(0);
  });

  it('flags protected _bar lacking @internal', () => {
    const project = makeProject();
    project.createSourceFile('c.ts', `export class D { protected _bar = 1; }\n`);
    const errors = lintProjectSource(project);
    expect(errors.some((e) => e.rule === 'R-internal-B' && e.name === '_bar')).toBe(true);
  });
});

describe('lint-internal R-internal-C (@internal without _ prefix)', () => {
  it('flags @internal on plain `foo` (missing _ prefix)', () => {
    const project = makeProject();
    project.createSourceFile('rc1.ts', `export class C {\n  /** @internal */\n  foo = 0;\n}\n`);
    const errors = lintProjectSource(project);
    expect(errors.some((e) => e.rule === 'R-internal-C' && e.name === 'foo')).toBe(true);
  });

  it('passes @internal + _foo (both halves agree)', () => {
    const project = makeProject();
    project.createSourceFile(
      'rc2.ts',
      `export class C {\n  /** @internal */\n  private _foo = 0;\n}\n`,
    );
    const errors = lintProjectSource(project);
    expect(errors.filter((e) => e.rule === 'R-internal-C')).toHaveLength(0);
  });
});

describe('lint-internal R-internal-D (module-level `let _xxx` without @internal)', () => {
  it('flags top-level `let _instance` missing @internal', () => {
    const project = makeProject();
    project.createSourceFile(
      'd1.ts',
      `let _instance: number | null = null;\nexport function getInstance() { return _instance; }\n`,
    );
    const errors = lintProjectSource(project);
    expect(errors.some((e) => e.rule === 'R-internal-D' && e.name === '_instance')).toBe(true);
  });

  it('passes top-level `let _instance` with @internal', () => {
    const project = makeProject();
    project.createSourceFile(
      'd2.ts',
      `/** @internal */\nlet _instance: number | null = null;\nexport function getInstance() { return _instance; }\n`,
    );
    const errors = lintProjectSource(project);
    expect(errors.filter((e) => e.rule === 'R-internal-D')).toHaveLength(0);
  });
});

describe('lint-internal R-internal-E (interface field _ prefix without @internal, no cascade)', () => {
  it('flags interface field _foo lacking @internal', () => {
    const project = makeProject();
    project.createSourceFile('e1.ts', `export interface I { _foo: number; }\n`);
    const errors = lintProjectSource(project);
    expect(errors.some((e) => e.rule === 'R-internal-E' && e.name === '_foo')).toBe(true);
  });

  it('passes interface field with field-level /** @internal */', () => {
    const project = makeProject();
    project.createSourceFile(
      'e2.ts',
      `export interface I {\n  /** @internal */\n  _foo: number;\n}\n`,
    );
    const errors = lintProjectSource(project);
    expect(errors.filter((e) => e.rule === 'R-internal-E')).toHaveLength(0);
  });

  it('does NOT cascade from interface-level @internal to its fields (OOS-13)', () => {
    const project = makeProject();
    project.createSourceFile('e3.ts', `/** @internal */\nexport interface I { _foo: number; }\n`);
    const errors = lintProjectSource(project);
    expect(errors.some((e) => e.rule === 'R-internal-E' && e.name === '_foo')).toBe(true);
  });
});

describe('lint-internal aggregate behaviour', () => {
  it('returns empty errors for a clean fixture (control)', () => {
    const project = makeProject();
    project.createSourceFile(
      'clean.ts',
      `export class C {\n  /** @internal */\n  private _foo = 0;\n  bar = 1;\n}\nexport interface I {\n  /** @internal */\n  _bar: number;\n  baz: number;\n}\n/** @internal */\nlet _state: number | null = null;\nexport function getState() { return _state; }\n`,
    );
    const errors = lintProjectSource(project);
    expect(errors).toHaveLength(0);
  });

  it('aggregates multi-rule errors in one project', () => {
    const project = makeProject();
    project.createSourceFile(
      'agg.ts',
      `export class C { private _a = 0; }\nexport interface I { _b: number; }\nlet _c: number | null = null;\nexport function poke() { return _c; }\n`,
    );
    const errors = lintProjectSource(project);
    const rules = new Set(errors.map((e) => e.rule));
    expect(rules.has('R-internal-B')).toBe(true);
    expect(rules.has('R-internal-D')).toBe(true);
    expect(rules.has('R-internal-E')).toBe(true);
  });
});
