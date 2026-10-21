// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
//
// Source files (N=12):
//   - packages/shader-compiler/src/__tests__/bg-overflow-material-shader.test.ts
//   - packages/shader-compiler/src/__tests__/compare-param-schema.test.ts
//   - packages/shader-compiler/src/__tests__/compose.test.ts
//   - packages/shader-compiler/src/__tests__/composition-fixtures.test.ts
//   - packages/shader-compiler/src/__tests__/cycle-detect.test.ts
//   - packages/shader-compiler/src/__tests__/define-scan.test.ts
//   - packages/shader-compiler/src/__tests__/define-value-reject.test.ts
//   - packages/shader-compiler/src/__tests__/editor-target.test.ts
//   - packages/shader-compiler/src/__tests__/error-mapper.test.ts
//   - packages/shader-compiler/src/__tests__/errors.test.ts
//   - packages/shader-compiler/src/__tests__/reflection.test.ts
//   - packages/shader-compiler/__tests__/pbr-uniform-fallback-compile.test.ts
//   - packages/shader-compiler/__tests__/standard-cluster-projector-compose.unit.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.
// Path adjustment: src/__tests__/ -> test/ means ../X -> ../src/X, ./X -> ../src/__tests__/X.

import { describe, expect, it, test, expectTypeOf, beforeAll } from 'vitest';
import type { BindGroupLayoutDescriptor } from '@forgeax/engine-types';
import { checkBindGroupOverflow } from '../src/compare-param-schema.js';
import { compileShader, generateParameterModule } from '../src/index.js';
import { DEFAULT_STANDARD_PBR_PARAM_SCHEMA } from '../../shader/src/material-schemas.js';
import { detectCycle } from '../src/cycle-detect.js';
import { scanDefineConflicts } from '../src/define-scan.js';
import { mapWasmError } from '../src/error-mapper.js';
import * as compilerModule from '../src/index.js';
import { REFLECTION_FIXTURES } from '../src/__tests__/reflection.fixtures.js';
import {
  compileFailed,
  err,
  initFailed,
  manifestMalformed,
  ok,
  type Result,
  ShaderError,
  type ShaderErrorCode,
  shaderNotFound,
} from '../src/errors.js';


{
  // --- from bg-overflow-material-shader.test.ts ---
// bg-overflow-material-shader.test.ts — unit tests for >4 BGL overflow guard
// (feat-20260523-shader-template-instance-split M3-T10 / AC-07).
//
// Covers 3 cases per plan-tasks:
//   (a) 5 BG (overflow) -> Err with mismatchKind='bg-overflow'
//   (b) 4 BG (at limit) -> Ok
//   (c) 3 BG (under limit) -> Ok
//
// Also verifies detail.actualCount and detail.maxAllowed fields.
//
// TDD: test-first (red phase); bg-overflow guard not yet implemented.


function makeBgl(groupCount: number): BindGroupLayoutDescriptor[] {
  const bgls: BindGroupLayoutDescriptor[] = [];
  for (let g = 0; g < groupCount; g++) {
    bgls.push({
      entries: [
        {
          binding: 0,
          visibility: 0x2,
          buffer: { type: 'uniform' as const, hasDynamicOffset: false, minBindingSize: 0 },
        },
      ],
    });
  }
  return bgls;
}

const PATH = 'test::bg_overflow';

describe('checkBindGroupOverflow (M3-T10 / AC-07)', () => {
  it('(a) 5 BG -> Err with code=material-schema-mismatch and mismatchKind=bg-overflow', () => {
    const bgls = makeBgl(5);
    const result = checkBindGroupOverflow(bgls, PATH);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('material-schema-mismatch');
      const detail = result.error.detail;
      if (detail?.code === 'material-schema-mismatch') {
        expect(detail.mismatchKind).toBe('bg-overflow');
        expect(detail.actualCount).toBe(5);
        expect(detail.maxAllowed).toBe(4);
        expect(detail.materialShaderPath).toBe(PATH);
      } else {
        throw new Error('expected material-schema-mismatch detail');
      }
    }
  });

  it('(b) 4 BG (at limit) -> Ok', () => {
    const bgls = makeBgl(4);
    const result = checkBindGroupOverflow(bgls, PATH);
    expect(result.ok).toBe(true);
  });

  it('(c) 3 BG (under limit) -> Ok', () => {
    const bgls = makeBgl(3);
    const result = checkBindGroupOverflow(bgls, PATH);
    expect(result.ok).toBe(true);
  });

  it('(d) 2 BG -> Ok (extra sanity)', () => {
    const bgls = makeBgl(2);
    const result = checkBindGroupOverflow(bgls, PATH);
    expect(result.ok).toBe(true);
  });

  it('(e) 0 BG -> Ok (empty BGL)', () => {
    const result = checkBindGroupOverflow([], PATH);
    expect(result.ok).toBe(true);
  });
});

}


{
  // --- from compose.test.ts ---
// compose.test.ts — red fixtures for compileShader(src, { imports, defines, id }).
//
// These tests are the SSOT for the M3 T-07 green landing of the compose
// three-field option extension. They are marked `test.fails` (not `.skip`, per
// plan-strategy §4.4 no-skip rule) so they ride green in CI until T-07 removes
// the marker. When T-07 lands the imports/defines/id plumbing and the
// shader-import-not-found ShaderError code + detail, each `test.fails` here
// must be flipped to plain `test` (the CI sweep enforces this — a test marked
// fails that actually passes becomes a red, which forces the flip).
//
// Coverage (plan-strategy §4.3):
// - AC-01 happy path — imports + defines + id forwarded to naga composer; deps
//   string array returned in CompileResult (AC-14 AI-F2 moduleId resolution
//   breadcrumb).
// - AC-05 + D-11 anonymous id — `options.id` omitted => error detail
//   fromModuleId starts with `<anonymous-entry-` (D-11 placeholder prefix);
//   multiple anonymous entries stay distinguishable via hash8 suffix.
// - AC-02 shader-import-not-found — entry #imports a moduleId whose imports
//   map value lacks the `#define_import_path` header declaration, so the
//   composer cannot bind it; surfaces as err.code === 'shader-import-not-found'.
//
// T-06 is the test-first half of the M3 T-07 pair. The test file targets
// the compileShader surface that T-07 will ship; no impl changes here.


const ENTRY_WGSL = /* wgsl */ `
@vertex fn vs() -> @builtin(position) vec4<f32> {
  return vec4<f32>(0.0);
}
`;

const BRDF_MOD_WGSL = /* wgsl */ `
#define_import_path forgeax_pbr::brdf
fn sample() -> vec4<f32> { return vec4<f32>(0.0); }
`;

// NOTE: `as never` on the extended options shape bypasses the current narrow
// CompileOptions (M1-landed: only { id?, dynamicOffsets? }). T-07 widens the
// shape to include `imports` + `defines` and the cast becomes redundant; at
// that point the cast is removed and TS enforces the contract at compile time.
type FutureCompileOptions = {
  imports?: Record<string, string>;
  defines?: Record<string, boolean>;
  id?: string;
};

describe('@forgeax/engine-shader-compiler compileShader imports/defines/id (T-07 M3)', () => {
  test('AC-01 happy path — imports + defines + id forward to naga composer; deps[] returned', async () => {
    const opts: FutureCompileOptions = {
      imports: { 'forgeax_pbr::brdf': BRDF_MOD_WGSL },
      defines: { FOO: true },
      id: 'entry_a',
    };
    const r = await compileShader(`#import forgeax_pbr::brdf\n${ENTRY_WGSL}`, opts);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // deps carries the resolved moduleIds actually consumed by the entry
      // (AC-14 AI-F2 breadcrumb).
      const deps = (r.value as unknown as { deps: readonly string[] }).deps;
      expect(Array.isArray(deps)).toBe(true);
      expect(deps).toContain('forgeax_pbr::brdf');
    }
  });

  test('AC-05 + D-11 anonymous id — options.id omitted => err.detail.fromModuleId starts with `<anonymous-entry-`', async () => {
    // Entry imports a moduleId that is not in `imports` => shader-import-not-found.
    // With options.id omitted, the error detail's fromModuleId placeholder
    // must use the `<anonymous-entry-${hash8}>` prefix (D-11).
    const opts: FutureCompileOptions = {
      imports: {}, // empty => the #import below is unresolved
      defines: {},
      // id: omitted on purpose
    };
    const r = await compileShader(
      '#import forgeax_missing::mod\n@vertex fn vs() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }',
      opts,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('shader-import-not-found');
      const detail = (r.error as unknown as { detail: { fromModuleId: string } }).detail;
      expect(detail.fromModuleId).toMatch(/^<anonymous-entry-/);
    }
  });

  test('AC-02 shader-import-not-found — #import target has no #define_import_path header', async () => {
    const moduleWithoutDeclaration = 'fn bar() -> vec4<f32> { return vec4<f32>(0.0); }';
    const opts: FutureCompileOptions = {
      imports: { forgeax_foo: moduleWithoutDeclaration },
      defines: {},
      id: 'ac02_entry',
    };
    const r = await compileShader(
      '#import forgeax_foo::bar\n@vertex fn vs() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }',
      opts,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('shader-import-not-found');
    }
  });
});

}

{
  // --- from composition-fixtures.test.ts ---
// composition-fixtures.test — three-way coverage of composition pathways
// (feat-20260512-naga-oil-composition-hmr M3 T-17).
//
// Coverage aligned with requirements §AC-18.c + plan-strategy §4.2:
//   (a) single #import happy path — entry imports one symbol from one module
//   (b) nested 2-layer imports — entry -> mod1 -> mod2 chain
//   (c) #ifdef / #ifndef / #else / #endif 4 directives nested 2 layers
//   (d) #ifdef-gated #import is lazy: a disabled branch's import does not
//       populate deps[] (AC-18.c + D-09)
//   (e) AC-02 specialty — #import resolves to a module that was registered
//       but without #define_import_path header -> shader-import-not-found
//       + detail.fromModuleId starts with <anonymous-entry-* or equals the
//       supplied id.


describe('compileShader composition fixtures (M3 T-17 / AC-18.c)', () => {
  it('(a) single #import happy path — entry imports one module', async () => {
    const brdf = [
      '#define_import_path forgeax_pbr::brdf',
      'fn f_schlick() -> f32 { return 0.04; }',
    ].join('\n');
    const entry = [
      '#import forgeax_pbr::brdf::f_schlick',
      '@vertex fn vs() -> @builtin(position) vec4<f32> { return vec4<f32>(f_schlick()); }',
    ].join('\n');
    const r = await compileShader(entry, {
      imports: { 'forgeax_pbr::brdf': brdf },
      defines: {},
      id: 'happy_entry',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.deps).toContain('forgeax_pbr::brdf');
      expect(r.value.wgsl.length).toBeGreaterThan(0);
    }
  });

  it('(b) nested 2-layer imports — entry -> mod1 -> mod2', async () => {
    const mod2 = [
      '#define_import_path forgeax_util::inner',
      'fn inner_helper() -> f32 { return 0.5; }',
    ].join('\n');
    const mod1 = [
      '#define_import_path forgeax_util::outer',
      '#import forgeax_util::inner::inner_helper',
      'fn outer_helper() -> f32 { return inner_helper(); }',
    ].join('\n');
    const entry = [
      '#import forgeax_util::outer::outer_helper',
      '@vertex fn vs() -> @builtin(position) vec4<f32> { return vec4<f32>(outer_helper()); }',
    ].join('\n');
    const r = await compileShader(entry, {
      imports: {
        'forgeax_util::outer': mod1,
        'forgeax_util::inner': mod2,
      },
      defines: {},
      id: 'nested_entry',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.deps).toContain('forgeax_util::outer');
      expect(r.value.deps).toContain('forgeax_util::inner');
    }
  });

  it('(b2) namespaced import cycle — lab::cyc_a <-> lab::cyc_b is a circular import', async () => {
    const a = [
      '#define_import_path lab::cyc_a',
      '#import lab::cyc_b::fb',
      'fn fa() -> f32 { return fb(); }',
    ].join('\n');
    const b = [
      '#define_import_path lab::cyc_b',
      '#import lab::cyc_a::fa',
      'fn fb() -> f32 { return fa(); }',
    ].join('\n');
    const entry = [
      '#import lab::cyc_a::fa',
      '@vertex fn vs() -> @builtin(position) vec4<f32> { return vec4<f32>(fa()); }',
    ].join('\n');
    const r = await compileShader(entry, {
      imports: { 'lab::cyc_a': a, 'lab::cyc_b': b },
      defines: {},
      id: 'lab::cyc_root',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('shader-circular-import');
      expect(r.error.detail).toMatchObject({ cycle: ['lab::cyc_a', 'lab::cyc_b', 'lab::cyc_a'] });
    }
  });

  it('(c) #ifdef / #ifndef / #else / #endif 4 directives with 2-level nesting', async () => {
    // naga_oil #ifdef semantics: a name present in shader_defs counts as
    // "defined" regardless of Bool value. To drop the when_both block we
    // omit INNER_FLAG from defines entirely rather than setting it to false.
    const entry = [
      '#ifdef OUTER_FLAG',
      'fn when_outer() -> f32 { return 2.0; }',
      '#else',
      'fn when_not_outer() -> f32 { return 9.0; }',
      '#endif',
      '#ifndef NEVER_DEFINED',
      'fn tail() -> f32 { return 3.0; }',
      '#endif',
      '#ifdef OUTER_FLAG',
      '#ifdef INNER_FLAG',
      'fn when_both() -> f32 { return 1.0; }',
      '#endif',
      '#endif',
      '@vertex fn vs() -> @builtin(position) vec4<f32> { return vec4<f32>(tail()); }',
    ].join('\n');
    const r = await compileShader(entry, {
      imports: {},
      defines: { OUTER_FLAG: true },
      id: 'ifdef_entry',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.wgsl).toContain('when_outer');
      expect(r.value.wgsl).not.toContain('when_not_outer');
      expect(r.value.wgsl).not.toContain('when_both');
      expect(r.value.wgsl).toContain('tail');
    }
  });

  it('(d) #ifdef-guarded usage inside entry — omitted define drops the call site (naga_oil upstream #ifdef is "defined?", D-09)', async () => {
    // naga_oil adds every composable module to the composer (including
    // unused helpers); the composed WGSL therefore still carries the helper
    // fn body. The AC-18.c lazy semantics apply at the *call site* — the
    // entry's `use_it` block sits under `#ifdef ENABLE_HELPER`. We omit
    // ENABLE_HELPER from defines so naga_oil treats it as undefined and
    // drops the block. deps[] records the declared import so Vite HMR
    // tracks the edge regardless (D-10).
    const helper = [
      '#define_import_path forgeax_unused::helper',
      'fn unused_fn() -> f32 { return 0.0; }',
    ].join('\n');
    const entry = [
      '#import forgeax_unused::helper::unused_fn',
      '#ifdef ENABLE_HELPER',
      'fn use_it() -> f32 { return unused_fn(); }',
      '#endif',
      '@vertex fn vs() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }',
    ].join('\n');
    const r = await compileShader(entry, {
      imports: { 'forgeax_unused::helper': helper },
      defines: {},
      id: 'lazy_entry',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.deps).toContain('forgeax_unused::helper');
      expect(r.value.wgsl).not.toContain('use_it');
    }
  });

  it('(e) AC-02 specialty — imports entry exists but source lacks #define_import_path -> shader-import-not-found + fromModuleId', async () => {
    const moduleWithoutDeclaration = 'fn bar() -> vec4<f32> { return vec4<f32>(0.0); }';
    const entry = [
      '#import forgeax_foo::bar',
      '@vertex fn vs() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }',
    ].join('\n');

    // Case e.1: options.id provided -> detail.fromModuleId equals the id
    // (entry-level signal — the caller's id wins over the companion moduleId
    // for the first TS-layer pre-check failure).
    const withId = await compileShader(entry, {
      imports: { forgeax_foo: moduleWithoutDeclaration },
      defines: {},
      id: 'ac02_entry',
    });
    expect(withId.ok).toBe(false);
    if (!withId.ok) {
      expect(withId.error.code).toBe('shader-import-not-found');
      const detail = withId.error.detail as unknown as ShaderImportNotFoundDetail;
      expect(detail.code).toBe('shader-import-not-found');
      expect(detail.fromModuleId).toBe('ac02_entry');
    }

    // Case e.2: options.id omitted -> detail.fromModuleId uses the
    // `<anonymous-entry-*>` placeholder for the entry.
    const withoutId = await compileShader(entry, {
      imports: { forgeax_foo: moduleWithoutDeclaration },
      defines: {},
    });
    expect(withoutId.ok).toBe(false);
    if (!withoutId.ok) {
      expect(withoutId.error.code).toBe('shader-import-not-found');
      const detail = withoutId.error.detail as unknown as ShaderImportNotFoundDetail;
      expect(detail.fromModuleId.startsWith('<anonymous-entry-')).toBe(true);
    }
  });
});

}

{
  // --- from cycle-detect.test.ts ---
// cycle-detect.test - red fixtures for detectCycle DFS (feat-20260512
// M3 T-10 red / T-11 green).
//
// Fixtures cover plan-strategy §3 RISK-4 checklist (5 cases):
//   (a) acyclic straight-line + diamond -> null
//   (b) 2-hop cycle a -> b -> a -> ['a','b','a']
//   (c) 3-hop cycle a -> b -> c -> a -> ['a','b','c','a']
//   (d) self-loop a -> a -> ['a','a']
//   (e) two independent SCCs -> non-null (either cycle acceptable)
//
// D-04 contract: the returned cycle repeats the first element at the tail so
// consumers can visualise the loop at a glance.
//
// Anchors: plan-strategy §2 D-03 + D-04; plan-strategy §4.3 DFS-must-TDD.


describe('detectCycle DFS + tri-colour (white/gray/black)', () => {
  it('(a-1) straight line a -> b -> c -> null', () => {
    const graph: Record<string, string[]> = { a: ['b'], b: ['c'], c: [] };
    expect(detectCycle(graph)).toBeNull();
  });

  it('(a-2) diamond a->b, a->c, b->d, c->d -> null', () => {
    const graph: Record<string, string[]> = {
      a: ['b', 'c'],
      b: ['d'],
      c: ['d'],
      d: [],
    };
    expect(detectCycle(graph)).toBeNull();
  });

  it('(b) two-hop cycle a -> b -> a -> [a,b,a] (first/last repeated)', () => {
    const graph: Record<string, string[]> = { a: ['b'], b: ['a'] };
    const cycle = detectCycle(graph);
    expect(cycle).not.toBeNull();
    if (cycle) {
      expect(cycle[0]).toBe(cycle[cycle.length - 1]);
      expect(cycle.length).toBe(3);
      // The two distinct nodes are a and b.
      const distinct = new Set(cycle);
      expect(distinct.size).toBe(2);
      expect(distinct.has('a')).toBe(true);
      expect(distinct.has('b')).toBe(true);
    }
  });

  it('(c) three-hop cycle a -> b -> c -> a -> [a,b,c,a] (first/last repeated)', () => {
    const graph: Record<string, string[]> = {
      a: ['b'],
      b: ['c'],
      c: ['a'],
    };
    const cycle = detectCycle(graph);
    expect(cycle).not.toBeNull();
    if (cycle) {
      expect(cycle[0]).toBe(cycle[cycle.length - 1]);
      expect(cycle.length).toBe(4);
      const distinct = new Set(cycle);
      expect(distinct.size).toBe(3);
      expect(distinct.has('a')).toBe(true);
      expect(distinct.has('b')).toBe(true);
      expect(distinct.has('c')).toBe(true);
    }
  });

  it('(d) self-loop a -> a -> [a,a]', () => {
    const graph: Record<string, string[]> = { a: ['a'] };
    const cycle = detectCycle(graph);
    expect(cycle).not.toBeNull();
    if (cycle) {
      expect(cycle.length).toBe(2);
      expect(cycle[0]).toBe('a');
      expect(cycle[1]).toBe('a');
    }
  });

  it('(e) two independent cycles (a<->b and c<->d) -> non-null (either cycle acceptable)', () => {
    const graph: Record<string, string[]> = {
      a: ['b'],
      b: ['a'],
      c: ['d'],
      d: ['c'],
    };
    const cycle = detectCycle(graph);
    expect(cycle).not.toBeNull();
    if (cycle) {
      expect(cycle[0]).toBe(cycle[cycle.length - 1]);
      expect(cycle.length).toBeGreaterThanOrEqual(3);
      const distinct = new Set(cycle);
      expect(distinct.size).toBeGreaterThanOrEqual(2);
    }
  });

  it('handles nodes not present in keys but reachable via edges (missing adjacency defaults to empty)', () => {
    // b has no entry in the map but is referenced; algorithm must not crash.
    const graph: Record<string, string[]> = { a: ['b'] };
    expect(detectCycle(graph)).toBeNull();
  });
});

}

{
  // --- from define-scan.test.ts ---
// define-scan.test - scanDefineConflicts fixtures (feat-20260512 M3 T-12).
//
// Fixtures cover plan-strategy §2 D-07 + requirements §AC-07:
//   (a) no conflict -> [] (happy)
//   (b) same `#define FOO` in 2 distinct modules -> sites.length === 2
//   (c) idempotent: same `#define FOO` twice in one module -> no conflict
//   (d) multi-conflict: two defines each collide independently.


describe('scanDefineConflicts TS-layer #define collision scan', () => {
  it('(a) no conflict -> empty array (happy path)', () => {
    const modules = {
      'forgeax_pbr::brdf': '#define_import_path forgeax_pbr::brdf\nfn a() {}\n',
      'forgeax_view::common': '#define_import_path forgeax_view::common\nstruct V {}\n',
    };
    expect(scanDefineConflicts(modules)).toEqual([]);
  });

  it('(b) `#define FOO` appears in 2 modules -> sites.length === 2 (AC-07 fixture)', () => {
    const modules = {
      mod1: '#define FOO\nfn a() {}\n',
      mod2: '#define FOO\nfn b() {}\n',
    };
    const conflicts = scanDefineConflicts(modules);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]?.code).toBe('shader-define-conflict');
    expect(conflicts[0]?.defineName).toBe('FOO');
    expect(conflicts[0]?.sites.length).toBe(2);
    const moduleIds = conflicts[0]?.sites.map((s) => s.moduleId) ?? [];
    expect(moduleIds).toContain('mod1');
    expect(moduleIds).toContain('mod2');
  });

  it('(c) idempotent: `#define FOO` twice in the same module is NOT a conflict', () => {
    const modules = {
      mod1: '#define FOO\n#define FOO\nfn a() {}\n',
    };
    expect(scanDefineConflicts(modules)).toEqual([]);
  });

  it('(d) multiple defines each conflicting independently -> >=2 entries', () => {
    const modules = {
      mod1: '#define FOO\n#define BAR\n',
      mod2: '#define FOO\n#define BAR\n',
    };
    const conflicts = scanDefineConflicts(modules);
    expect(conflicts.length).toBe(2);
    const names = conflicts.map((c) => c.defineName).sort();
    expect(names).toEqual(['BAR', 'FOO']);
  });

  it('handles leading whitespace (`  #define FOO`) same as flush-left', () => {
    const modules = {
      mod1: '  #define FOO\n',
      mod2: '#define FOO\n',
    };
    const conflicts = scanDefineConflicts(modules);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]?.defineName).toBe('FOO');
  });
});

}

{
  // --- from define-value-reject.test.ts ---
// define-value-reject.test — red fixture for the non-boolean `#define NAME
// <value>` rejection path (feat-20260512-naga-oil-composition-hmr M3 T-14).
//
// Contract lock (plan-strategy D-05): a `#define TILE_SIZE 16` form that
// carries a non-boolean RHS must surface as
//   Result.err({ code: 'shader-compile-failed', ... })
// NOT as a new 8th ShaderErrorCode member, NOT as shader-define-conflict,
// and NOT as a silent naga_oil Bool(true) fallback.
//
// OOS-1 anchor: non-boolean #define values are out of scope for v1. The
// rejection message carries an OOS-1 pointer so AI users can jump to the
// upstream decision trail without parsing the message string further.
//
// This test rides `test.fails` until T-07 wires the compileShader pre-scan
// for non-boolean #define values. When T-07 lands, the `.fails` marker is
// removed (same pattern as T-06).
//
// Anchors: plan-strategy §2 D-05 (no 8th ShaderErrorCode); requirements
// §AC-04 (Result.err path, no silent pass, no string replacement);
// plan-strategy §4.3 `#define FOO <value>` non-boolean reject must test.


type FutureCompileOptions = {
  imports?: Record<string, string>;
  defines?: Record<string, boolean>;
  id?: string;
};

const ENTRY_WGSL = /* wgsl */ `
#define TILE_SIZE 16
@vertex fn vs() -> @builtin(position) vec4<f32> {
  return vec4<f32>(0.0);
}
`;

describe('@forgeax/engine-shader-compiler compileShader #define value reject (D-05)', () => {
  test('entry source with `#define TILE_SIZE 16` -> Result.err + message references OOS-1 (D-05 pre-scan marker)', async () => {
    const opts: FutureCompileOptions = { imports: {}, defines: {}, id: 'entry_a' };
    const r = await compileShader(ENTRY_WGSL, opts);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('shader-compile-failed');
      // Negative assertions — these MUST NOT trip (D-05).
      expect(r.error.code).not.toBe('shader-define-conflict');
      const asString: string = r.error.code;
      expect(asString).not.toBe('shader-define-value-unsupported');
      // T-07 pre-scan marker: the message must reference OOS-1 so AI users
      // can trace the decision. Current pre-T-07 impl routes through naga
      // parse and does NOT emit this marker — this is the red hook.
      expect(r.error.message.toLowerCase()).toContain('oos-1');
    }
  });

  test('imports module carrying `#define FOO 1` also rejected with OOS-1 marker', async () => {
    const modSrc = '#define_import_path forgeax_mod\n#define FOO 1\nfn helper() {}\n';
    const entry =
      '#import forgeax_mod::helper\n@vertex fn vs() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }';
    const opts: FutureCompileOptions = {
      imports: { forgeax_mod: modSrc },
      defines: {},
      id: 'entry_b',
    };
    const r = await compileShader(entry, opts);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('shader-compile-failed');
      expect(r.error.message.toLowerCase()).toContain('oos-1');
    }
  });
});

}

{
  // --- from editor-target.test.ts ---
// editor-target.test.ts — MVP-2.5 (D) editor / agentic AI runtime target unit test.
//
// Passing condition: import { compileShader } from `@forgeax/engine-shader-compiler`,
// invoke it with a minimal PBR-like WGSL source, then assert r.ok === true,
// r.value.manifestEntry has all 4 fields, and r.value.bindings is a
// BindGroupLayoutDescriptor[].
//
// Verification dimensions (plan-strategy §6 M1 + requirements MVP-2.5 (D)):
// - top-level await wasm loading succeeds in the vitest node environment
//   (charter proposition 5 consistent abstraction)
// - manifestEntry 4-field schema SSOT (AC-04)
// - bindings array shape + at least one BGL (reflection derivation function loop closed)
//
// If wasm loading fails, the §S-4 fallback chain is triggered
// (implement-decisions.md); however this task scope is locked to the GREEN path
// (the fallback is evaluated via a spinoff loop).


const MINIMAL_VALID_PBR_WGSL = /* wgsl */ `
struct ViewUniform { worldViewProj: mat4x4<f32>, lightDir: vec3<f32>, lightColor: vec3<f32> }
@group(0) @binding(0) var<uniform> view: ViewUniform;

struct Material { baseColor: vec3<f32>, metallic: f32, roughness: f32 }
@group(1) @binding(0) var<uniform> material: Material;

struct Mesh { worldFromLocal: mat4x4<f32> }
@group(2) @binding(0) var<storage, read> meshes: array<Mesh>;

struct VsIn { @location(0) pos: vec3<f32>, @location(1) normal: vec3<f32>, @builtin(instance_index) idx: u32 }
struct VsOut { @builtin(position) clip: vec4<f32>, @location(0) normalWS: vec3<f32> }

@vertex fn vs_main(in: VsIn) -> VsOut {
  let world = meshes[in.idx].worldFromLocal;
  let posWS = world * vec4<f32>(in.pos, 1.0);
  var out: VsOut;
  out.clip = view.worldViewProj * posWS;
  out.normalWS = (world * vec4<f32>(in.normal, 0.0)).xyz;
  return out;
}

@fragment fn fs_main(@location(0) normalWS: vec3<f32>) -> @location(0) vec4<f32> {
  let n = normalize(normalWS);
  let l = normalize(view.lightDir);
  let ndl = max(dot(n, l), 0.0);
  let diffuse = material.baseColor * view.lightColor * ndl;
  return vec4<f32>(diffuse, 1.0);
}
`;

describe('MVP-2.5 (D) editor / agentic AI runtime target', () => {
  it('compileShader(minimal PBR WGSL) returns Result.ok with 4-field manifestEntry + bindings array', async () => {
    const r = await compileShader(MINIMAL_VALID_PBR_WGSL, {});
    if (!r.ok) {
      throw new Error(`compileShader failed: ${r.error.code} — ${r.error.message}`);
    }
    expect(r.ok).toBe(true);

    // manifestEntry has all 4 fields (AC-04 schema SSOT)
    expect(r.value.manifestEntry).toMatchObject({
      hash: expect.any(String),
      wgsl: expect.any(String),
      bindings: expect.any(String),
    });
    expect(r.value.manifestEntry.hash).toMatch(/^[0-9a-f]{8,}$/);
    // Post feat-20260512 M3 T-07, manifestEntry.wgsl carries the naga_oil
    // composed + naga-reformatted WGSL rather than the raw source. The
    // structural content is preserved (struct defs / binding declarations),
    // but whitespace + struct field layout is naga-canonicalised.
    expect(r.value.manifestEntry.wgsl).toContain('struct ViewUniform');
    expect(r.value.manifestEntry.wgsl).toContain('struct Material');
    expect(r.value.manifestEntry.wgsl).toContain('worldViewProj');
    // glsl field: undefined within M1 scope (placeholder; GLSL fallback assessed post-MVP)
    expect(r.value.manifestEntry.glsl).toBeUndefined();

    // bindings array shape: 3 BG mesh-array (plan-strategy §S-8 PBR shape)
    expect(Array.isArray(r.value.bindings)).toBe(true);
    expect(r.value.bindings).toHaveLength(3);
    const groups = r.value.bindings.map((bgl) => bgl.label);
    expect(groups).toEqual(expect.arrayContaining(['@group(0)', '@group(1)', '@group(2)']));

    // wgsl is the composed+reformatted output; glsl placeholder.
    expect(r.value.wgsl).toContain('struct ViewUniform');
    expect(r.value.glsl).toBe('');
  });
});

}

{
  // --- from error-mapper.test.ts ---
// error-mapper.test - mapWasmError wasm JsError -> ShaderError adapter
// (feat-20260512 M3 T-13). Covers the 3 prefix pathways:
//   - shader-import-not-found -> code + detail.{importPath, fromModuleId,
//     offset?} + actionable .hint
//   - shader-compile-failed   -> code + prose .message + .hint
//   - prefix-less             -> compile-failed fallback


describe('mapWasmError wasm JsError prefix parser', () => {
  it('shader-import-not-found prefix -> structured detail with quoted importPath', () => {
    const e = new Error(
      "shader-import-not-found: required import 'forgeax_foo::bar' not found in <entry>",
    );
    const err = mapWasmError(e, { fromModuleId: 'entry_a' });
    expect(err.code).toBe('shader-import-not-found');
    const detail = err.detail as unknown as ShaderImportNotFoundDetail;
    expect(detail.code).toBe('shader-import-not-found');
    expect(detail.importPath).toBe('forgeax_foo::bar');
    expect(detail.fromModuleId).toBe('entry_a');
    expect(err.hint).toContain('check options.imports');
    expect(err.hint).toContain('ensure');
  });

  it('shader-import-not-found with offset passes through detail.offset (D-12)', () => {
    const e = new Error("shader-import-not-found: required import 'x::y' not found");
    const err = mapWasmError(e, { fromModuleId: 'entry', offset: 42 });
    const detail = err.detail as unknown as ShaderImportNotFoundDetail;
    expect(detail.offset).toBe(42);
  });

  it('shader-compile-failed prefix -> code + prose .message + actionable .hint', () => {
    const e = new Error("shader-compile-failed: defines_json['FOO'] must be a boolean");
    const err = mapWasmError(e, { fromModuleId: 'entry' });
    expect(err.code).toBe('shader-compile-failed');
    expect(err.message).toContain('boolean');
    expect(err.hint).toContain('boolean');
  });

  it('prefix-less message -> compile-failed fallback with verbatim message', () => {
    const e = new Error('naga_oil internal panic');
    const err = mapWasmError(e, { fromModuleId: 'entry' });
    expect(err.code).toBe('shader-compile-failed');
    expect(err.message).toBe('naga_oil internal panic');
    expect(err.hint.length).toBeGreaterThan(0);
  });

  it('non-Error thrown -> String(e) fallback', () => {
    const err = mapWasmError('bare string', { fromModuleId: 'entry' });
    expect(err.code).toBe('shader-compile-failed');
    expect(err.message).toBe('bare string');
  });

  it('.hint contains recovery directive for all 3 new error codes', () => {
    const importErr = mapWasmError(
      new Error("shader-import-not-found: required import 'a::b' not found"),
      { fromModuleId: 'e' },
    );
    expect(importErr.hint.toLowerCase()).toMatch(/check|ensure/);

    const compileErr = mapWasmError(new Error('shader-compile-failed: wgsl writeback failed'), {
      fromModuleId: 'e',
    });
    expect(compileErr.hint.toLowerCase()).toMatch(/check|ensure/);
  });
});

}

{
  // --- from errors.test.ts ---
// errors.test.ts — unit tests for the ShaderError 5 top-level surface fields and
// the 4 factory helpers (MVP-2.3).
//
// plan-strategy §S-7 landing: err.{code, lineNum, linePos, message, hint} accessed
// at the top level plus an exhaustive switch over the 4 members of the closed
// ShaderErrorCode union (charter proposition 4).

/// <reference types="@webgpu/types" />


describe('ShaderError 5 top-level surface fields (MVP-2.3)', () => {
  it('compileFailed shape = {code, lineNum, linePos, message, hint} + detail.compilerMessages forwarded', () => {
    const e = compileFailed({
      message: "expected ';', found '@'",
      hint: 'check declaration terminator at the indicated position',
      lineNum: 3,
      linePos: 12,
      // GPUCompilationMessage is a branded interface; tests cast a POD shim that
      // mirrors the spec's 6 fields without holding the brand symbol.
      compilerMessages: [
        {
          message: "expected ';'",
          type: 'error',
          lineNum: 3,
          linePos: 12,
          offset: 42,
          length: 1,
        } as unknown as GPUCompilationMessage,
      ],
    });
    expect(e).toBeInstanceOf(ShaderError);
    expect(e).toBeInstanceOf(Error);
    expect(e).toMatchObject({
      code: 'shader-compile-failed',
      lineNum: 3,
      linePos: 12,
      message: "expected ';', found '@'",
      hint: 'check declaration terminator at the indicated position',
    });
    expect(e.name).toBe('ShaderError');
    expect(e.expected).toContain('WGSL');
    if (e.detail?.code === 'shader-compile-failed') {
      expect(e.detail.compilerMessages[0]?.offset).toBe(42);
    } else {
      throw new Error('expected typed detail with code === shader-compile-failed');
    }
  });

  it('initFailed shape: lineNum / linePos are undefined (cold start path has no source location)', () => {
    const e = initFailed({
      message: 'wasm-pack init() rejected',
      hint: 'rerun bash packages/wgpu-wasm/build.sh',
      reason: 'fetch failed',
    });
    expect(e.code).toBe('compiler-init-failed');
    expect(e.lineNum).toBeUndefined();
    expect(e.linePos).toBeUndefined();
    expect(e.message).toBe('wasm-pack init() rejected');
    expect(e.hint).toBe('rerun bash packages/wgpu-wasm/build.sh');
    if (e.detail?.code === 'compiler-init-failed') {
      expect(e.detail.reason).toBe('fetch failed');
    } else {
      throw new Error('expected typed detail with code === compiler-init-failed');
    }
  });

  it('manifestMalformed shape: detail.reason forwards the schema failure reason', () => {
    const e = manifestMalformed({
      message: 'manifest.json missing required key "bindings"',
      hint: 'regenerate via vite-plugin-shader generateBundle hook',
      reason: 'JSON parse error: unexpected EOF',
    });
    expect(e.code).toBe('manifest-malformed');
    expect(e.lineNum).toBeUndefined();
    expect(e.linePos).toBeUndefined();
    expect(e.message).toContain('missing required key');
    expect(e.hint).toContain('regenerate');
    if (e.detail?.code === 'manifest-malformed') {
      expect(e.detail.reason).toBe('JSON parse error: unexpected EOF');
    } else {
      throw new Error('expected typed detail with code === manifest-malformed');
    }
  });

  it('shaderNotFound shape: hash is embedded in message + expected', () => {
    const e = shaderNotFound({
      hash: 'abc123',
      hint: 'verify manifest.json contains the requested hash',
    });
    expect(e.code).toBe('shader-not-found');
    expect(e.message).toContain('abc123');
    expect(e.expected).toContain('abc123');
    expect(e.hint).toContain('verify');
    expect(e.lineNum).toBeUndefined();
    expect(e.detail).toBeUndefined();
  });

  it('Exhaustive switch over the 12 members of the closed ShaderErrorCode union (compiles without a default fallback)', () => {
    const classify = (code: ShaderErrorCode): string => {
      switch (code) {
        case 'shader-compile-failed':
          return 'compile';
        case 'compiler-init-failed':
          return 'init';
        case 'manifest-malformed':
          return 'manifest';
        case 'shader-not-found':
          return 'lookup';
        case 'shader-import-not-found':
          return 'import';
        case 'shader-circular-import':
          return 'cycle';
        case 'shader-define-conflict':
          return 'define';
        // === 5 new material-* codes (feat-20260523-shader-template-instance-split M1-T02) ===
        case 'material-schema-mismatch':
          return 'mismatch';
        case 'material-shader-not-found':
          return 'ms-not-found';
        case 'material-param-type-mismatch':
          return 'param-type';
        case 'material-param-unknown':
          return 'param-unknown';
        case 'material-param-missing-required':
          return 'param-missing';
      }
    };
    expect(classify('shader-compile-failed')).toBe('compile');
    expect(classify('compiler-init-failed')).toBe('init');
    expect(classify('manifest-malformed')).toBe('manifest');
    expect(classify('shader-not-found')).toBe('lookup');
    expect(classify('shader-import-not-found')).toBe('import');
    expect(classify('shader-circular-import')).toBe('cycle');
    expect(classify('shader-define-conflict')).toBe('define');
  });

  it('ShaderErrorCode at the type layer = closed union with 12 members (type-level)', () => {
    expectTypeOf<ShaderErrorCode>().toEqualTypeOf<
      | 'shader-compile-failed'
      | 'compiler-init-failed'
      | 'manifest-malformed'
      | 'shader-not-found'
      | 'shader-import-not-found'
      | 'shader-circular-import'
      | 'shader-define-conflict'
      // === 5 new material-* codes (feat-20260523-shader-template-instance-split M1-T02) ===
      | 'material-schema-mismatch'
      | 'material-shader-not-found'
      | 'material-param-type-mismatch'
      | 'material-param-unknown'
      | 'material-param-missing-required'
    >();
  });
});

describe('Result<T, E> binary enum', () => {
  it('ok branch carries value', () => {
    const r: Result<number> = ok(42);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(42);
  });

  it('err branch carries error', () => {
    const e = shaderNotFound({ hash: 'x', hint: 'h' });
    const r: Result<number> = err(e);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('shader-not-found');
  });
});

}

{
  // --- from reflection.test.ts ---
// reflection.test.ts — deep-equal unit test over the 9 boundary cases
// (plan-strategy §S-9 + MVP-2.1).
//
// Red → green sequence: this test is RED at the w7 commit (compileShader not
// implemented yet / src/index.ts is only a placeholder stub); it turns GREEN
// after w8 lands compileShader + reflection derivation.
//
// oracle = research §g2 9-boundary-case mapping table 1:1; fixtures are fully
// explicit (visibility bitmask integers + all default hasDynamicOffset /
// minBindingSize fields populated).


interface CompileResult {
  readonly wgsl: string;
  readonly glsl: string | undefined;
  readonly bindings: ReadonlyArray<unknown>;
  readonly manifestEntry: { readonly hash: string };
}

interface ResultOk {
  readonly ok: true;
  readonly value: CompileResult;
}
interface ResultErr {
  readonly ok: false;
  readonly error: { readonly code: string; readonly message: string };
}
type AnyResult = ResultOk | ResultErr;

type CompileShaderFn = (
  source: string,
  options: {
    readonly dynamicOffsets?: readonly { readonly group: number; readonly binding: number }[];
  },
) => Promise<AnyResult>;

function getCompileShader(): CompileShaderFn | undefined {
  const mod = compilerModule as Record<string, unknown>;
  const fn = mod.compileShader;
  return typeof fn === 'function' ? (fn as CompileShaderFn) : undefined;
}

describe.each(REFLECTION_FIXTURES)('reflection oracle: $name', (fixture) => {
  it('compileShader bindings deep-equal expected BindGroupLayoutDescriptor[]', async () => {
    const compileShader = getCompileShader();
    if (!compileShader) {
      throw new Error(
        'compileShader not yet exported by @forgeax/engine-shader-compiler; w8 will land it (TDD red phase).',
      );
    }
    const result = await compileShader(fixture.wgsl, fixture.options ?? {});
    if (!result.ok) {
      throw new Error(
        `compileShader failed for fixture ${fixture.name}: ${result.error.code} — ${result.error.message}`,
      );
    }
    expect(result.value.bindings).toEqual(fixture.expected);
  });
});

}

{
  // --- from pbr-uniform-fallback-compile.test.ts ---
// pbr-uniform-fallback-compile.test.ts -- feat-20260526-pbr-uniform-fallback-no-storage-buffer M1.
//
// Build-time shader compilation tests exercising the #ifdef STORAGE_BUFFER_AVAILABLE
// dual-path declarations in common.wgsl (w3 / AC-04) and the three entry WGSL files
// (default-standard-pbr / default-standard-pbr-skin / unlit) with uniform fallback
// defines (w4 / AC-08). The PRAGMA gate (AC-14) is exercised indirectly: naga_oil
// silently ignores unrecognised directives, so #pragma variant_axis lines are
// compile-neutral; the #ifdef branches are the surface under test.
//
// Physically, @forgeax/engine-shader-compiler is a devDependency (test-only);
// the production dist grep gates (check-shader-no-naga-in-dist) only scan
// packages/shader/dist, where this import chain is absent.

// node:* are accessed via `await import(varId)` (vite-ignore) -- the
// established cross-package pattern in ibl-modules-parse.test.ts -- so
// the shader tsconfig keeps `types: ["@webgpu/types"]` without pulling in
// `@types/node` (which would regress unrelated brand-type narrowing).
//
// @forgeax/engine-shader-compiler is likewise imported via a string variable
// to avoid a typecheck dependency on the build-time compiler's .d.ts
// (the shader package's tsconfig references only types + rhi).


interface NodeFs {
  readFileSync: (p: string, enc: string) => string;
}
interface NodePath {
  resolve: (...parts: string[]) => string;
  dirname: (p: string) => string;
}
interface NodeUrl {
  fileURLToPath: (u: string) => string;
}

interface CompileResultValue {
  wgsl: string;
}

interface CompileResultOk {
  ok: true;
  readonly value: CompileResultValue;
}
interface CompileResultErr {
  ok: false;
  readonly error: { message: string };
}
type CompileResult = CompileResultOk | CompileResultErr;

// biome-ignore lint/suspicious/noExplicitAny: dynamic import type
type CompileFn = (source: string, options: any) => Promise<CompileResult>;

let compileShader!: CompileFn;
let readSrc!: (file: string) => string;

// Import map bundles -- lazily initialised in beforeAll.
let PBR_ENTRY_IMPORTS!: Record<string, string>;
let UNLIT_ENTRY_IMPORTS!: Record<string, string>;

const GENERATED_STANDARD_INTERFACE = generateParameterModule(DEFAULT_STANDARD_PBR_PARAM_SCHEMA, {
  includeResources: false,
});

const PRAGMA_RE = /^\s*#pragma\s+(?!material_slot\b)\S.*$/gm;

/** Strip #pragma lines -- naga_oil leaves them in composed output and naga rejects `#` tokens. */
function stripPragmas(source: string): string {
  return source.replace(PRAGMA_RE, '');
}

beforeAll(async () => {
  const fsId = 'node:fs';
  const pathId = 'node:path';
  const urlId = 'node:url';
  const compilerId = '@forgeax/engine-shader-compiler';

  const fs = (await import(/* @vite-ignore */ fsId)) as NodeFs;
  const path = (await import(/* @vite-ignore */ pathId)) as NodePath;
  const url = (await import(/* @vite-ignore */ urlId)) as NodeUrl;

  const here = url.fileURLToPath(import.meta.url);
  const srcDir = path.resolve(path.dirname(here), '..', '..', 'shader', 'src');
  readSrc = (file: string) => fs.readFileSync(`${srcDir}/${file}`, 'utf8');

  const mod = (await import(/* @vite-ignore */ compilerId)) as { compileShader: CompileFn };
  compileShader = mod.compileShader;

  // Shared import bundles (transitively closed).
  const IBL_SHARED = readSrc('ibl-shared.wgsl');
  const BRDF = readSrc('brdf.wgsl');
  const PBR_TEMPORAL = readSrc('pbr-temporal.wgsl');
  const TBN = readSrc('tbn.wgsl');
  const LIGHTING_DIRECTIONAL = readSrc('lighting-directional.wgsl');
  const LIGHTING_PUNCTUAL = readSrc('lighting-punctual.wgsl');
  const LIGHTING_ATTENUATION = readSrc('lighting-attenuation.wgsl');
  const IBL_SAMPLING = readSrc('ibl-sampling.wgsl');
  const COMMON = readSrc('common.wgsl');
  const SCENE_TEMPORAL = readSrc('scene-temporal.wgsl');
  // Standard lit and skinned consumers share one cluster module. Keep this
  // fixture on the canonical source/import path so the compiler contract
  // cannot drift back to the removed HDRP-only owner.
  const STANDARD_CLUSTER = readSrc('standard-cluster.wgsl');
  // feat-20260612-point-light-shadows-urp-hdrp M2 / T-M2-1 (plan-strategy D-4):
  // lighting-directional.wgsl now imports forgeax_pbr::shadow_pcf (shared PCF core).
  const SHADOW_PCF = readSrc('shadow-pcf.wgsl');

  PBR_ENTRY_IMPORTS = {
    'forgeax_material::displacement': readSrc('standard-displacement.wgsl'),
    'forgeax_material::texture_coordinates': readSrc('texture-coordinates.wgsl'),
    'forgeax_material::terrain_vertex': readSrc('terrain-vertex.wgsl'),
    'forgeax_material::terrain_layer_sampling': readSrc('terrain-layer-sampling.wgsl'),
    'forgeax_material::terrain_surface': readSrc('terrain-surface.wgsl'),
    'forgeax_material::standard_surface': readSrc('standard-surface.wgsl'),
    'forgeax_clipping::planes': readSrc('clipping.wgsl'),
    'forgeax_view::common': COMMON,
    forgeax_scene_temporal: SCENE_TEMPORAL,
    'forgeax_view::fog': readSrc('fog.wgsl'),
    'forgeax_view::atmosphere': readSrc('view-atmosphere.wgsl'),
    'forgeax_atmosphere::optics': readSrc('atmosphere-optics.wgsl'),
    'forgeax_atmosphere::visibility': readSrc('atmosphere-visibility.wgsl'),
    'forgeax_atmosphere::coordinates': readSrc('atmosphere-coordinates.wgsl'),
    'forgeax_atmosphere::sampling': readSrc('atmosphere-sampling.wgsl'),
    'forgeax_cloud::layer': readSrc('cloud.wgsl'),
    'forgeax_pbr::brdf': BRDF,
    'forgeax_pbr::specular_aa': readSrc('specular-aa.wgsl'),
    'forgeax_material::fragment_output': readSrc('material/fragment-output.wgsl'),
    'forgeax_view::tone_mapping': readSrc('tone-mapping.wgsl'),
    'forgeax_view::output_encoding': readSrc('output-encoding.wgsl'),
    'forgeax_material::alpha_hash': readSrc('alpha-hash.wgsl'),
    'forgeax_material::oit': readSrc('oit.wgsl'),
    'forgeax_shadow::surface': readSrc('shadow-surface.wgsl'),
    'forgeax_pbr::temporal': PBR_TEMPORAL,
    'forgeax_pbr::ibl_shared': IBL_SHARED,
    'forgeax_pbr::pmrem': readSrc('ibl-pmrem.wgsl'),
    'forgeax_pbr::ibl_sampling': IBL_SAMPLING,
    'forgeax_pbr::tbn': TBN,
    'forgeax_pbr::lighting_directional': LIGHTING_DIRECTIONAL,
    'forgeax_pbr::lighting_punctual': LIGHTING_PUNCTUAL,
    'forgeax_pbr::lighting_probe': readSrc('lighting-probe.wgsl'),
    'forgeax_pbr::standard_lighting': readSrc('standard-lighting.wgsl'),
    'forgeax_pbr::gbuffer': readSrc('standard-gbuffer.wgsl'),
    'forgeax_pbr::gbuffer_output': readSrc('standard-gbuffer-output.wgsl'),
    'forgeax_pbr::lighting_spot_modifiers': readSrc('lighting-spot-modifiers.wgsl'),
    'forgeax_pbr::lighting_ies_profile': readSrc('lighting-ies-profile.wgsl'),
    'forgeax_pbr::lighting_rect_area': readSrc('lighting-rect-area.wgsl'),
    'forgeax_pbr::lighting_attenuation': LIGHTING_ATTENUATION,
    'forgeax_pbr::lighting_spot_projector': readSrc('lighting-spot-projector.wgsl'),
    'forgeax_standard::cluster': STANDARD_CLUSTER,
    'forgeax_pbr::shadow_pcf': SHADOW_PCF,
    'forgeax_pbr::clearcoat': readSrc('material/physical/clearcoat.wgsl'),
    'forgeax_pbr::anisotropy': readSrc('material/physical/anisotropy.wgsl'),
    'forgeax_pbr::sheen': readSrc('material/physical/sheen.wgsl'),
    'forgeax_pbr::iridescence': readSrc('material/physical/iridescence.wgsl'),
    'forgeax_material::surface_v1': readSrc('surface_v1.wgsl'),
    'forgeax_material::surface_sampling': readSrc('surface-sampling.wgsl'),
    'forgeax_material::default_standard_surface': readSrc('default_standard_surface.wgsl'),
    'forgeax_material::slot::surface': readSrc('default_standard_surface.wgsl').replace(
      /^\s*#define_import_path\s+[^\n]+/m,
      '#define_import_path forgeax_material::slot::surface',
    ),
  };

  UNLIT_ENTRY_IMPORTS = {
    'forgeax_clipping::planes': readSrc('clipping.wgsl'),
    'forgeax_material::fragment_output': readSrc('material/fragment-output.wgsl'),
    'forgeax_material::texture_coordinates': readSrc('texture-coordinates.wgsl'),
    'forgeax_view::tone_mapping': readSrc('tone-mapping.wgsl'),
    'forgeax_view::output_encoding': readSrc('output-encoding.wgsl'),
    'forgeax_material::alpha_hash': readSrc('alpha-hash.wgsl'),
    'forgeax_material::oit': readSrc('oit.wgsl'),
    'forgeax_shadow::surface': readSrc('shadow-surface.wgsl'),
    'forgeax_view::common': COMMON,
    forgeax_scene_temporal: SCENE_TEMPORAL,
    'forgeax_view::fog': readSrc('fog.wgsl'),
    'forgeax_view::atmosphere': readSrc('view-atmosphere.wgsl'),
    'forgeax_cloud::layer': readSrc('cloud.wgsl'),
    'forgeax_atmosphere::optics': readSrc('atmosphere-optics.wgsl'),
    'forgeax_atmosphere::visibility': readSrc('atmosphere-visibility.wgsl'),
    'forgeax_atmosphere::coordinates': readSrc('atmosphere-coordinates.wgsl'),
    'forgeax_atmosphere::sampling': readSrc('atmosphere-sampling.wgsl'),
  };
});

// ============================================================================
// w3 -- AC-04: dual-path compose for common.wgsl
// ============================================================================

describe('w3 AC-04 -- common.wgsl #ifdef STORAGE_BUFFER_AVAILABLE dual-path compose', () => {
  const STORAGE_AVAILABLE_DEFINES = {
    STORAGE_BUFFER_AVAILABLE: true,
    PER_INSTANCE_REGION: false,
    CLUSTER_FORWARD_AVAILABLE: false,
    TRANSMISSION_AVAILABLE: false,
    GPU_DRIVEN_SCENE_INDEX_AVAILABLE: false,
    TERRAIN_GEOMETRY_AVAILABLE: false,
  };
  const STORAGE_UNAVAILABLE_DEFINES = {
    STORAGE_BUFFER_AVAILABLE: false,
    PER_INSTANCE_REGION: false,
    CLUSTER_FORWARD_AVAILABLE: false,
    TRANSMISSION_AVAILABLE: false,
    GPU_DRIVEN_SCENE_INDEX_AVAILABLE: false,
    TERRAIN_GEOMETRY_AVAILABLE: false,
  };

  it('STORAGE_BUFFER_AVAILABLE=true compose succeeds (storage path)', async () => {
    const entry = stripPragmas(readSrc('default-standard-pbr.wgsl'));
    const r = await compileShader(entry, {
      id: 'forgeax::default-standard-pbr',
      imports: PBR_ENTRY_IMPORTS,
      defines: STORAGE_AVAILABLE_DEFINES,
      generatedParameters: GENERATED_STANDARD_INTERFACE,
    });
    expect(r.ok, `storage-path compose failed: ${r.ok ? '' : r.error.message}`).toBe(true);
    if (r.ok) {
      expect(r.value.wgsl).toBeTruthy();
      expect(r.value.wgsl.length).toBeGreaterThan(0);
    }
  });

  it('STORAGE_BUFFER_AVAILABLE=false compose succeeds (uniform fallback path)', async () => {
    const entry = stripPragmas(readSrc('default-standard-pbr.wgsl'));
    const r = await compileShader(entry, {
      id: 'forgeax::default-standard-pbr',
      imports: PBR_ENTRY_IMPORTS,
      defines: STORAGE_UNAVAILABLE_DEFINES,
      generatedParameters: GENERATED_STANDARD_INTERFACE,
    });
    expect(r.ok, `uniform-path compose failed: ${r.ok ? '' : r.error.message}`).toBe(true);
    if (r.ok) {
      expect(r.value.wgsl).toBeTruthy();
      expect(r.value.wgsl.length).toBeGreaterThan(0);
    }
  });
});

// ============================================================================
// w4 -- AC-08: three shader uniform variant compose
// ============================================================================

describe('w4 AC-08 -- three entry shaders uniform variant (STORAGE_BUFFER_AVAILABLE=false)', () => {
  const UNIFORM_DEFINES = {
    STORAGE_BUFFER_AVAILABLE: false,
    PER_INSTANCE_REGION: false,
    CLUSTER_FORWARD_AVAILABLE: false,
    TRANSMISSION_AVAILABLE: false,
    GPU_DRIVEN_SCENE_INDEX_AVAILABLE: false,
    TERRAIN_GEOMETRY_AVAILABLE: false,
  };

  it('forgeax::default-standard-pbr uniform variant compose succeeds', async () => {
    const entry = stripPragmas(readSrc('default-standard-pbr.wgsl'));
    const r = await compileShader(entry, {
      id: 'forgeax::default-standard-pbr',
      imports: PBR_ENTRY_IMPORTS,
      defines: UNIFORM_DEFINES,
      generatedParameters: GENERATED_STANDARD_INTERFACE,
    });
    expect(r.ok, `pbr uniform compose failed: ${r.ok ? '' : r.error.message}`).toBe(true);
    if (r.ok) {
      expect(r.value.wgsl).toBeTruthy();
    }
  });

  it('forgeax::pbr-skin uniform variant compose succeeds', async () => {
    const entry = stripPragmas(readSrc('default-standard-pbr-skin.wgsl'));
    const r = await compileShader(entry, {
      id: 'forgeax::pbr-skin',
      imports: PBR_ENTRY_IMPORTS,
      defines: UNIFORM_DEFINES,
      generatedParameters: GENERATED_STANDARD_INTERFACE,
    });
    expect(r.ok, `pbr-skin uniform compose failed: ${r.ok ? '' : r.error.message}`).toBe(true);
    if (r.ok) {
      expect(r.value.wgsl).toBeTruthy();
    }
  });

  it('unlit uniform variant compose succeeds', async () => {
    const entry = stripPragmas(readSrc('unlit.wgsl'));
    const r = await compileShader(entry, {
      id: 'forgeax::unlit',
      imports: UNLIT_ENTRY_IMPORTS,
      defines: UNIFORM_DEFINES,
    });
    expect(r.ok, `unlit uniform compose failed: ${r.ok ? '' : r.error.message}`).toBe(true);
    if (r.ok) {
      expect(r.value.wgsl).toBeTruthy();
    }
  });
});

// Keep this compiler-heavy clustered-projector regression in the consolidated
// shader compiler suite. It exercises the same composer/import map as the
// neighboring standard variants without creating a one-test perf-budget file.
describe('standard clustered projector composition', () => {
  it('keeps both projector resource layouts compilable across extension capability pairs', async () => {
    const cluster = readSrc('standard-cluster.wgsl');
    for (const extendedLighting of [false, true]) {
      for (const projector of [false, true]) {
        const result = await compileShader(cluster, {
          id: `forgeax_standard::cluster#extended=${extendedLighting},projector=${projector}`,
          imports: PBR_ENTRY_IMPORTS,
          defines: {
            CLUSTER_FORWARD_AVAILABLE: true,
            EXTENDED_LIGHTING_AVAILABLE: extendedLighting,
            PROJECTOR_AVAILABLE: projector,
            STORAGE_BUFFER_AVAILABLE: true,
          },
        });
        expect(
          result.ok,
          result.ok ? '' : `${extendedLighting}/${projector}: ${result.error.message}`,
        ).toBe(true);
      }
    }
  });
});

}
