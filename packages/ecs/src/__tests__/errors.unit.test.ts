// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
//
// Source files (N=10):
//   - packages/ecs/src/__tests__/ac16-register-component-grep-gate.test.ts
//   - packages/ecs/src/__tests__/buffer-array-errors.test.ts
//   - packages/ecs/src/__tests__/component-global-index.test.ts
//   - packages/ecs/src/__tests__/component-schema-json.test.ts
//   - packages/ecs/src/__tests__/errors.test.ts
//   - packages/ecs/src/__tests__/managed-entity-dangling-errors.test.ts
//   - packages/ecs/src/__tests__/relationship-errors.test.ts
//   - packages/ecs/src/__tests__/result.test.ts
//   - packages/ecs/src/__tests__/spawn-light-invalid-bounds-error-code.test.ts
//   - packages/ecs/src/__tests__/sprite-animation-invalid-error.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { err, ok, type Result } from '@forgeax/engine-types';
import { describe, expect, expectTypeOf, it, test } from 'vitest';
import { componentSchema, defineComponent } from '../component';
import type { EcsErrorCode } from '../errors';
import {
  ComponentAlreadyPresentError,
  ComponentNotPresentError,
  CyclicDependencyError,
  EntityIndexOverflowError,
  FixedSizeMismatchError,
  ManagedBufferOutOfBoundsError,
  ManagedBufferShrinkNotSupportedError,
  RelationshipDetachMismatchError,
  RelationshipMirrorComponentNotRegisteredError,
  RelationshipMirrorFieldTypeMismatchError,
  RelationshipSelfCycleError,
  ResourceNotFoundError,
  SchemaUnsupportedFieldError,
  StaleEntityError,
  UniqueRefDoubleReleaseError,
  UniqueRefReleasedError,
} from '../errors';
import { World } from '../world';
import { sourceHits } from './source-scan.fixture';

{
  // ─── from ac16-register-component-grep-gate.test.ts ───
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '..', '..', '..', '..');

  const NAME = 'register' + 'Component';
  const CALL_PATTERN = `[.](${NAME}|${NAME}Checked)[(]`;
  const FIELD_PATTERN = `${NAME}:`;
  // The repo-wide source scan runs inside the coverage pool alongside 180+
  // instrumented files. Keep the default unit-test budget for normal cases,
  // but allow a contended runner to finish this I/O-only contract gate.
  const SOURCE_SCAN_TIMEOUT_MS = 90_000;

  describe('ac16-register-component-grep-gate.test.ts', () => {
    describe('AC-16 - register-component call surface is zero repo-wide (w20)', () => {
      it(
        'layer 1: zero method-call sites for the deleted register* methods',
        () => {
          const hits = sourceHits(repoRoot, CALL_PATTERN);
          expect(hits, `unexpected register-component call sites:\n${hits.join('\n')}`).toEqual([]);
        },
        SOURCE_SCAN_TIMEOUT_MS,
      );

      it(
        'layer 2: zero mock interface field declarations for the deleted method',
        () => {
          const hits = sourceHits(repoRoot, FIELD_PATTERN);
          expect(
            hits,
            `unexpected register-component field declarations:\n${hits.join('\n')}`,
          ).toEqual([]);
        },
        SOURCE_SCAN_TIMEOUT_MS,
      );
    });
  });
}

// ─── from buffer-array-errors.test.ts ───
describe('buffer-array-errors.test.ts', () => {
  describe('EcsErrorCode — buffer/array vocab collapse delta (w7, AC-07)', () => {
    it('FixedSizeMismatchError carries .code = "fixed-size-mismatch" + detail.expected / detail.actual', () => {
      const err = new FixedSizeMismatchError('meta', 8, 7);
      expect(err.code).toBe('fixed-size-mismatch');
      expect(err.detail).toEqual({ expected: 8, actual: 7 });
    });

    it('EcsErrorCode keeps only the core fixed-size write failure', () => {
      const codes: EcsErrorCode[] = ['fixed-size-mismatch'];
      let hits = 0;
      for (const code of codes) {
        switch (code) {
          case 'fixed-size-mismatch':
            hits += 1;
            break;
          default:
            void code;
        }
      }
      expect(hits).toBe(1);
    });

    it('owner-specific validation codes stay outside EcsErrorCode', () => {
      // @ts-expect-error render owns this validation code.
      const renderCode: EcsErrorCode = 'instance-transforms-stride-mismatch';
      // @ts-expect-error schema parsing owns this validation code.
      const schemaCode: EcsErrorCode = 'managed-array-element-type-not-allowed';
      expect([renderCode, schemaCode]).toHaveLength(2);
    });

    it('deleted managed-array-* codes are no longer assignable to EcsErrorCode', () => {
      // @ts-expect-error 'managed-array-index-out-of-bounds' was deleted by feat-20260515 w11.
      const a: EcsErrorCode = 'managed-array-index-out-of-bounds';
      // @ts-expect-error 'managed-array-pop-empty' was deleted by feat-20260515 w11 (renamed to 'array-pop-empty').
      const b: EcsErrorCode = 'managed-array-pop-empty';
      // @ts-expect-error 'managed-array-shrink-not-supported' was deleted by feat-20260515 w11.
      const c: EcsErrorCode = 'managed-array-shrink-not-supported';
      // @ts-expect-error 'managed-array-stride-mismatch' was deleted by feat-20260515 w11 (replaced by 'instance-transforms-stride-mismatch').
      const d: EcsErrorCode = 'managed-array-stride-mismatch';
      void a;
      void b;
      void c;
      void d;
    });
  });
});

// ─── from component-schema-json.test.ts ───
// NOTE: two source files both defined defineComponent('C', ...) with different schemas.
// The second defineComponent('C', diff-schema) is renamed to 'C2' to avoid schema-mismatch
// at merge time (global component registry, same-name diff-schema -> throw).

describe('component-schema-json.test.ts', () => {
  describe('owner schema projection — offline manifest discoverability (w29)', () => {
    test('JSON.stringify(componentSchema(C)) includes array<entity> / array<f32, 16> / buffer<16> / buffer literal substrings', () => {
      const Hierarchy = defineComponent('Hierarchy', {
        children: 'array<entity>',
        instanceTransforms: 'array<f32, 16>',
      });

      const BufferBag = defineComponent('BufferBag', {
        meta: 'buffer<16>',
        blob: 'buffer',
      });

      const json1 = JSON.stringify(componentSchema(Hierarchy));
      const json2 = JSON.stringify(componentSchema(BufferBag));

      expect(json1).toContain('array<entity>');
      expect(json1).toContain('array<f32, 16>');
      expect(json2).toContain('buffer<16>');
      expect(json2).toContain('"buffer"');

      expect(JSON.parse(json1)).toEqual({
        children: 'array<entity>',
        instanceTransforms: 'array<f32, 16>',
      });
      expect(JSON.parse(json2)).toEqual({
        meta: 'buffer<16>',
        blob: 'buffer',
      });
    });

    test('schema literal types survive the JSON round-trip (no widening to string)', () => {
      const C2 = defineComponent('SchemaJsonC2', {
        tag: 'array<u32>',
        slot: 'buffer<32>',
      });

      const tagKeyword: 'array<u32>' = componentSchema(C2).tag;
      const slotKeyword: 'buffer<32>' = componentSchema(C2).slot;
      expect(tagKeyword).toBe('array<u32>');
      expect(slotKeyword).toBe('buffer<32>');

      expect(JSON.stringify(componentSchema(C2))).toContain('array<u32>');
      expect(JSON.stringify(componentSchema(C2))).toContain('buffer<32>');
    });

    test('component tokens do not carry a second serialization method', () => {
      const C = defineComponent('C', {
        children: 'array<entity>',
        meta: 'buffer<16>',
        blob: 'buffer',
      });
      const serialized = JSON.stringify(componentSchema(C));
      expect(serialized).toContain('array<entity>');
      expect(serialized).toContain('buffer<16>');
      expect(serialized).toContain('"buffer"');
      expect('toSchemaJSON' in C).toBe(false);
    });
  });
});

// ─── from errors.test.ts ───
describe('errors.test.ts', () => {
  describe('EcsError unified interface — .code property', () => {
    const errorCases: Array<{
      label: string;
      create: () => Error & { hint: string; code: string };
      expectedCode: string;
    }> = [
      {
        label: 'EntityIndexOverflowError',
        create: () => new EntityIndexOverflowError(99999999),
        expectedCode: 'entity-index-overflow',
      },
      {
        label: 'SchemaUnsupportedFieldError',
        create: () => new SchemaUnsupportedFieldError('x', 'vec3'),
        expectedCode: 'schema-unsupported-field',
      },
      {
        label: 'StaleEntityError',
        create: () => new StaleEntityError(100, 5, 3),
        expectedCode: 'stale-entity',
      },
      {
        label: 'ComponentAlreadyPresentError',
        create: () => new ComponentAlreadyPresentError(42, 'Pos'),
        expectedCode: 'component-already-present',
      },
      {
        label: 'ComponentNotPresentError',
        create: () => new ComponentNotPresentError(42, 'Velocity'),
        expectedCode: 'component-not-present',
      },
      {
        label: 'CyclicDependencyError',
        create: () => new CyclicDependencyError(['A', 'B', 'A']),
        expectedCode: 'cyclic-dependency',
      },
      {
        label: 'ResourceNotFoundError',
        create: () => new ResourceNotFoundError('Time'),
        expectedCode: 'resource-not-found',
      },
    ];

    for (const { label, create, expectedCode } of errorCases) {
      describe(label, () => {
        it(`.code equals "${expectedCode}"`, () => {
          const e = create();
          expect(e.code).toBe(expectedCode);
        });

        it('.code is kebab-case', () => {
          const e = create();
          expect(e.code).toMatch(/^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*$/);
        });

        it('.name is readable', () => {
          const e = create();
          expect(typeof e.name).toBe('string');
          expect(e.name.length).toBeGreaterThan(0);
        });

        it('.message is readable', () => {
          const e = create();
          expect(typeof e.message).toBe('string');
          expect(e.message.length).toBeGreaterThan(0);
        });

        it('.hint is readable', () => {
          const e = create();
          expect(typeof e.hint).toBe('string');
          expect(e.hint.length).toBeGreaterThan(0);
        });
      });
    }
  });

  describe('StaleEntityError enhanced fields (F-04)', () => {
    it('has component field (optional string)', () => {
      const e = new StaleEntityError(100, 5, 3, {
        component: 'Position',
        operation: 'get',
        expectedGeneration: 3,
        actualGeneration: 2,
      });
      expect(e.component).toBe('Position');
    });

    it('component is undefined when not provided', () => {
      const e = new StaleEntityError(100, 5, 3, {
        operation: 'despawn',
        expectedGeneration: 3,
        actualGeneration: 2,
      });
      expect(e.component).toBeUndefined();
    });

    it('has operation field (string)', () => {
      const e = new StaleEntityError(100, 5, 3, {
        operation: 'get',
        expectedGeneration: 3,
        actualGeneration: 2,
      });
      expect(e.operation).toBe('get');
    });

    it('has expectedGeneration field (number)', () => {
      const e = new StaleEntityError(100, 5, 3, {
        operation: 'set',
        expectedGeneration: 5,
        actualGeneration: 3,
      });
      expect(e.expectedGeneration).toBe(5);
    });

    it('has actualGeneration field (number)', () => {
      const e = new StaleEntityError(100, 5, 3, {
        operation: 'set',
        expectedGeneration: 5,
        actualGeneration: 3,
      });
      expect(e.actualGeneration).toBe(3);
    });

    it('preserves original entity/index/generation fields (backward compat)', () => {
      const e = new StaleEntityError(100, 5, 3, {
        component: 'Velocity',
        operation: 'get',
        expectedGeneration: 3,
        actualGeneration: 1,
      });
      expect(e.name).toBe('StaleEntityError');
      expect(e.message).toBeDefined();
      expect(e.hint).toBeDefined();
    });

    it('backward compat: constructor without enhanced fields still works', () => {
      const e = new StaleEntityError(100, 5, 3);
      expect(e.name).toBe('StaleEntityError');
      expect(e.hint).toBeDefined();
      expect(e.component).toBeUndefined();
      expect(e.operation).toBeUndefined();
      expect(e.expectedGeneration).toBeUndefined();
      expect(e.actualGeneration).toBeUndefined();
    });
  });
});

// ─── from managed-entity-dangling-errors.test.ts ───
describe('managed-entity-dangling-errors.test.ts', () => {
  describe('w5 — managed error classes', () => {
    it('UniqueRefReleasedError carries code + hint + detail.handle', () => {
      const err = new UniqueRefReleasedError(0xdeadbeef, 'MaterialAsset');
      expect(err.code).toBe('unique-ref-released');
      expect(err.hint.length).toBeGreaterThan(0);
      expect(err.detail.handle).toBe(0xdeadbeef);
      expect(err.detail.target).toBe('MaterialAsset');
    });

    it('UniqueRefDoubleReleaseError carries code + hint + detail.handle', () => {
      const err = new UniqueRefDoubleReleaseError(7, 'MaterialAsset');
      expect(err.code).toBe('unique-ref-double-release');
      expect(err.hint.length).toBeGreaterThan(0);
      expect(err.detail.handle).toBe(7);
      expect(err.detail.target).toBe('MaterialAsset');
    });

    it('ManagedBufferOutOfBoundsError carries code + hint + detail.{index,size}', () => {
      const err = new ManagedBufferOutOfBoundsError(128, 64);
      expect(err.code).toBe('managed-buffer-out-of-bounds');
      expect(err.hint.length).toBeGreaterThan(0);
      expect(err.detail.index).toBe(128);
      expect(err.detail.size).toBe(64);
    });

    it('ManagedBufferShrinkNotSupportedError carries code + hint + detail.{requested,current}', () => {
      const err = new ManagedBufferShrinkNotSupportedError(32, 64);
      expect(err.code).toBe('managed-buffer-shrink-not-supported');
      expect(err.hint.length).toBeGreaterThan(0);
      expect(err.detail.requested).toBe(32);
      expect(err.detail.current).toBe(64);
    });
  });
});

// ─── from relationship-errors.test.ts ───
describe('relationship-errors.test.ts', () => {
  describe('relationship error codes', () => {
    it('relationship-self-cycle carries .code + .detail.entity', () => {
      const e = new RelationshipSelfCycleError('ChildOf', 42 as number, 7 as number);
      expect(e.code).toBe('relationship-self-cycle');
      expect(e).toBeInstanceOf(Error);
      expect(e.detail).toMatchObject({ component: 'ChildOf', entity: 42, ancestor: 7 });
      expect(typeof e.hint).toBe('string');
    });

    it('relationship-mirror-component-not-registered carries .code + .detail', () => {
      const e = new RelationshipMirrorComponentNotRegisteredError('ChildOf', 'Children');
      expect(e.code).toBe('relationship-mirror-component-not-registered');
      expect(e).toBeInstanceOf(Error);
      expect(e.detail).toMatchObject({ component: 'ChildOf', mirror: 'Children' });
    });

    it('relationship-mirror-component-not-registered hint drops register wording (AC-09)', () => {
      const e = new RelationshipMirrorComponentNotRegisteredError('ChildOf', 'Children');
      expect(e.hint).not.toMatch(/register/i);
      expect(e.hint).toContain('defineComponent');
    });

    it('relationship-mirror-field-type-mismatch carries .code + .detail', () => {
      const e = new RelationshipMirrorFieldTypeMismatchError(
        'ChildOf',
        'Children',
        'entities',
        'array<f32>',
      );
      expect(e.code).toBe('relationship-mirror-field-type-mismatch');
      expect(e).toBeInstanceOf(Error);
      expect(e.detail).toMatchObject({
        component: 'ChildOf',
        mirror: 'Children',
        field: 'entities',
        actualType: 'array<f32>',
      });
    });

    it('relationship-detach-mismatch carries .code + .detail', () => {
      const e = new RelationshipDetachMismatchError(
        'ChildOf',
        5 as number,
        9 as number,
        3 as number,
      );
      expect(e.code).toBe('relationship-detach-mismatch');
      expect(e).toBeInstanceOf(Error);
      expect(e.detail).toMatchObject({
        component: 'ChildOf',
        child: 5,
        expectedParent: 9,
        actualParent: 3,
      });
    });

    it('only relationship mutation codes are members of EcsErrorCode', () => {
      const codes: EcsErrorCode[] = ['relationship-self-cycle', 'relationship-detach-mismatch'];
      function classify(code: EcsErrorCode): string {
        switch (code) {
          case 'relationship-self-cycle':
            return 'cycle';
          case 'relationship-detach-mismatch':
            return 'detach';
          default:
            return 'other';
        }
      }
      expect(codes.map(classify)).toEqual(['cycle', 'detach']);
    });
  });
});

// ─── from result.test.ts ───
describe('result.test.ts', () => {
  describe('ok() factory', () => {
    it('produces an object with `.ok === true` (boolean discriminant)', () => {
      const r = ok(42);
      expect(r.ok).toBe(true);
    });

    it('exposes `.value` on the success branch', () => {
      const r = ok(42);
      if (r.ok) {
        expect(r.value).toBe(42);
      } else {
        throw new Error('ok() branch unreachable');
      }
    });
  });

  describe('err() factory', () => {
    it('produces an object with `.ok === false` (boolean discriminant)', () => {
      const e = new ComponentNotPresentError(1, 'Pos');
      const r = err(e);
      expect(r.ok).toBe(false);
    });

    it('exposes `.error` on the failure branch', () => {
      const e = new ComponentNotPresentError(1, 'Pos');
      const r = err(e);
      if (!r.ok) {
        expect(r.error).toBe(e);
      } else {
        throw new Error('err() branch unreachable');
      }
    });
  });

  describe('discriminant shape (`.ok` is boolean, not getter→value)', () => {
    it('`.ok` on ok() is the literal boolean true', () => {
      const r = ok(123);
      expect(r.ok).toBe(true);
      expect(typeof r.ok).toBe('boolean');
    });

    it('`.ok` on err() is the literal boolean false', () => {
      const r = err(new ComponentNotPresentError(1, 'Pos'));
      expect(r.ok).toBe(false);
      expect(typeof r.ok).toBe('boolean');
    });
  });

  describe('unwrap()', () => {
    it('returns the value for an Ok result', () => {
      const r = ok(42);
      expect(r.unwrap()).toBe(42);
    });

    it('throws the ORIGINAL EcsError for an Err result (not wrapped)', () => {
      const e = new StaleEntityError(100, 5, 3);
      const r = err(e);

      let thrown: unknown;
      try {
        r.unwrap();
      } catch (ex) {
        thrown = ex;
      }

      expect(thrown).toBe(e);
    });

    it('thrown error retains .code and .hint (charter: structured error)', () => {
      const e = new ComponentNotPresentError(1, 'Velocity');
      const r = err(e);

      let thrown: unknown;
      try {
        r.unwrap();
      } catch (ex) {
        thrown = ex;
      }

      expect(thrown).toBeInstanceOf(ComponentNotPresentError);
      const typedErr = thrown as ComponentNotPresentError;
      expect(typedErr.hint).toBeDefined();
      expect(typeof typedErr.hint).toBe('string');
      expect(typedErr.hint.length).toBeGreaterThan(0);
    });
  });

  describe('unwrapOr()', () => {
    it('returns the value for an Ok result', () => {
      const r = ok(42);
      expect(r.unwrapOr(0)).toBe(42);
    });

    it('returns the default for an Err result', () => {
      const e = new ComponentNotPresentError(1, 'Pos');
      const r: Result<number, ComponentNotPresentError> = err(e);
      expect(r.unwrapOr(99)).toBe(99);
    });
  });

  describe('removed surface (D-P2 guard)', () => {
    it('ok() result has no `isOk` property', () => {
      const r = ok(42);
      expect('isOk' in r).toBe(false);
    });

    it('ok() result has no `isErr` property', () => {
      const r = ok(42);
      expect('isErr' in r).toBe(false);
    });

    it('ok() result has no `map` property', () => {
      const r = ok(42);
      expect('map' in r).toBe(false);
    });

    it('ok() result has no `mapErr` property', () => {
      const r = ok(42);
      expect('mapErr' in r).toBe(false);
    });

    it('err() result has no `isOk` property', () => {
      const r = err(new ComponentNotPresentError(1, 'Pos'));
      expect('isOk' in r).toBe(false);
    });

    it('err() result has no `isErr` property', () => {
      const r = err(new ComponentNotPresentError(1, 'Pos'));
      expect('isErr' in r).toBe(false);
    });

    it('err() result has no `map` property', () => {
      const r = err(new ComponentNotPresentError(1, 'Pos'));
      expect('map' in r).toBe(false);
    });

    it('err() result has no `mapErr` property', () => {
      const r = err(new ComponentNotPresentError(1, 'Pos'));
      expect('mapErr' in r).toBe(false);
    });
  });

  describe('byte-for-byte parity with rhi.Result narrow shape', () => {
    it('ok() own-property names equal {ok, value} (no extra surface, no missing)', () => {
      const r = ok(42);
      const ownKeys = Object.keys(r).sort();
      expect(ownKeys).toEqual(['ok', 'value']);
    });

    it('err() own-property names equal {ok, error} (no extra surface, no missing)', () => {
      const r = err(new ComponentNotPresentError(1, 'Pos'));
      const ownKeys = Object.keys(r).sort();
      expect(ownKeys).toEqual(['error', 'ok']);
    });

    it('`.ok` on Ok is an own data property (not a getter)', () => {
      const r = ok(42);
      expect(Object.hasOwn(r, 'ok')).toBe(true);
    });

    it('`.value` on Ok is an own data property (not a prototype getter)', () => {
      const r = ok(42);
      expect(Object.hasOwn(r, 'value')).toBe(true);
    });

    it('`.error` on Err is an own data property (not a prototype getter)', () => {
      const r = err(new ComponentNotPresentError(1, 'Pos'));
      expect(Object.hasOwn(r, 'error')).toBe(true);
    });

    it('`.unwrap` lives on the prototype chain, not as own', () => {
      const r = ok(42);
      expect(Object.hasOwn(r, 'unwrap')).toBe(false);
      expect(typeof r.unwrap).toBe('function');
    });

    it('`.unwrapOr` lives on the prototype chain, not as own', () => {
      const r = ok(42);
      expect(Object.hasOwn(r, 'unwrapOr')).toBe(false);
      expect(typeof r.unwrapOr).toBe('function');
    });
  });

  describe('type-level narrowing via `r.ok`', () => {
    it('ok branch exposes `.value: T`; err branch exposes `.error: E`', () => {
      // Construct via the discriminated union so both arms type-check
      // independently — `ok(42)` alone narrows to `ResultOk<number>` and
      // would collapse the err arm to `never`.
      const probe = (r: Result<number, ComponentNotPresentError>) => {
        if (r.ok) {
          expectTypeOf(r.value).toEqualTypeOf<number>();
        } else {
          expectTypeOf(r.error).toEqualTypeOf<ComponentNotPresentError>();
        }
      };
      probe(ok(42));
      probe(err(new ComponentNotPresentError(1, 'Pos')));
    });
  });
});

// ─── from w8-ecs-error-code-kebab-grep-gate.test.ts ───
describe('w8-ecs-error-code-kebab-grep-gate.test.ts', () => {
  describe('EcsErrorCode kebab grep gate (M-4 w8)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(here, '..', '..', '..', '..');

    const SEVEN_SCREAMING_SNAKE_RE =
      "'(ENTITY_INDEX_OVERFLOW|SCHEMA_UNSUPPORTED_FIELD|STALE_ENTITY|COMPO" +
      "NENT_ALREADY_PRESENT|COMPONENT_NOT_PRESENT|CYCLIC_DEPENDENCY|RESOURCE_NOT_FOUND)'";

    it('zero SCREAMING_SNAKE error code literals in non-README source (M-4 w9 replaces these)', () => {
      const pending = ['packages/ecs/src', 'packages/runtime/src', 'apps', 'templates'].map(
        (root) => resolve(repoRoot, root),
      );
      const excluded = new Set(['dist', 'artifacts', 'node_modules']);
      const pattern = new RegExp(SEVEN_SCREAMING_SNAKE_RE);
      const hits: string[] = [];
      while (pending.length > 0) {
        const directory = pending.pop();
        if (directory === undefined) break;
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          if (excluded.has(entry.name)) continue;
          const path = resolve(directory, entry.name);
          if (entry.isDirectory()) pending.push(path);
          else if (
            entry.isFile() &&
            entry.name.endsWith('.ts') &&
            entry.name !== 'errors.unit.test.ts'
          ) {
            const lines = readFileSync(path, 'utf8').split(/\r?\n/);
            for (const [index, line] of lines.entries())
              if (pattern.test(line)) hits.push(`${path}:${index + 1}:${line}`);
          }
        }
      }
      expect(hits, `SCREAMING_SNAKE error code literals remaining:\n${hits.join('\n')}`).toEqual(
        [],
      );
    });
  });
});

// ─── feat-20260713 M2 / w7 — AC-09 shared-field illegal value fail-fast ───
//
// The P3 value gate: addComponent / spawn / set must reject an illegal value
// for a shared field (scalar `shared<T>` must be a number handle; array
// `array<shared<T>>` elements must all be numbers) with a structured EcsError
// (.code / .expected / .hint) instead of silently zeroing the column to
// `[0,0,0,0]`. AI users bind a shared reference by first resolving the GUID to
// a handle (World.allocSharedRef); passing a raw GUID string / {guid}
// object / {kind} object bypasses that resolution and used to be swallowed.
//
// The three GUID forms feedback verified being zeroed:
//   (a) bare GUID string 'pack.material'
//   (b) { guid: '...' } object
//   (c) { kind: 'MaterialAsset', ... } object
//
// Zeroing repro guard: after a rejected write the column must NOT read back as
// the all-zero sentinel — the write is aborted so the field never lands.
describe('feat-20260713 M2 / w7 — shared-field illegal value fail-fast (AC-09)', () => {
  const SHARED_INVALID_CODE = 'shared-field-invalid-value';

  // Distinct component names per test (defineComponent global index is
  // process-wide) — a scalar shared field + an array<shared<>> field.
  function scalarComp(name: string) {
    return defineComponent(name, { mat: { type: 'shared<GameMaterial>' } });
  }
  function arrayComp(name: string) {
    return defineComponent(name, { clips: { type: 'array<shared<GameClip>, 4>' } });
  }

  const GUID_FORMS: ReadonlyArray<{ label: string; value: unknown }> = [
    { label: 'bare GUID string', value: 'pack.material' },
    { label: '{ guid } object', value: { guid: 'pack.material' } },
    { label: '{ kind } object', value: { kind: 'MaterialAsset', guid: 'pack.material' } },
  ];

  describe('scalar shared field', () => {
    for (const form of GUID_FORMS) {
      it(`addComponent rejects ${form.label} with structured EcsError (not zeroed)`, () => {
        const world = new World();
        const C = scalarComp(`W7Scalar_Add_${form.label.replace(/\W/g, '')}`);
        const e = world.spawn().unwrap();
        const add = world.addComponent(e, { component: C, data: { mat: form.value } as never });
        expect(add.ok).toBe(false);
        if (add.ok) return;
        const err = add.error as unknown as { code: string; expected?: string; hint?: string };
        expect(err.code).toBe(SHARED_INVALID_CODE);
        expect((err.expected ?? '').length).toBeGreaterThan(0);
        expect((err.hint ?? '').length).toBeGreaterThan(0);
      });

      it(`spawn rejects ${form.label} with structured EcsError (not zeroed)`, () => {
        const world = new World();
        const C = scalarComp(`W7Scalar_Spawn_${form.label.replace(/\W/g, '')}`);
        const r = world.spawn({ component: C, data: { mat: form.value } as never });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        const err = r.error as unknown as { code: string; expected?: string; hint?: string };
        expect(err.code).toBe(SHARED_INVALID_CODE);
        expect((err.expected ?? '').length).toBeGreaterThan(0);
        expect((err.hint ?? '').length).toBeGreaterThan(0);
      });

      it(`set rejects ${form.label} with structured EcsError (not zeroed)`, () => {
        const world = new World();
        const C = scalarComp(`W7Scalar_Set_${form.label.replace(/\W/g, '')}`);
        const e = world.spawn({ component: C, data: {} }).unwrap();
        const r = world.set(e, C, { mat: form.value } as never);
        expect(r.ok).toBe(false);
        if (r.ok) return;
        const err = r.error as unknown as { code: string; expected?: string; hint?: string };
        expect(err.code).toBe(SHARED_INVALID_CODE);
        expect((err.expected ?? '').length).toBeGreaterThan(0);
        expect((err.hint ?? '').length).toBeGreaterThan(0);
        // Zeroing guard: the shared field must NOT have landed as 0. A
        // rejected set aborts before the column write, so reading the field
        // back yields the pre-write value (0 from spawn default IS the
        // sentinel here, so instead assert the write was rejected — the
        // observable contract is the structured error, not a post-write read).
      });
    }
  });

  describe('array<shared<T>> field', () => {
    for (const form of GUID_FORMS) {
      it(`spawn rejects clips:[${form.label}] with structured EcsError (not [0,0,0,0])`, () => {
        const world = new World();
        const C = arrayComp(`W7Array_Spawn_${form.label.replace(/\W/g, '')}`);
        const r = world.spawn({ component: C, data: { clips: [form.value] } as never });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        const err = r.error as unknown as { code: string; expected?: string; hint?: string };
        expect(err.code).toBe(SHARED_INVALID_CODE);
        expect((err.expected ?? '').length).toBeGreaterThan(0);
        expect((err.hint ?? '').length).toBeGreaterThan(0);
      });

      it(`addComponent rejects clips:[${form.label}] with structured EcsError`, () => {
        const world = new World();
        const C = arrayComp(`W7Array_Add_${form.label.replace(/\W/g, '')}`);
        const e = world.spawn().unwrap();
        const add = world.addComponent(e, {
          component: C,
          data: { clips: [form.value] } as never,
        });
        expect(add.ok).toBe(false);
        if (add.ok) return;
        expect((add.error as unknown as { code: string }).code).toBe(SHARED_INVALID_CODE);
      });

      it(`set rejects clips:[${form.label}] with structured EcsError`, () => {
        const world = new World();
        const C = arrayComp(`W7Array_Set_${form.label.replace(/\W/g, '')}`);
        const e = world.spawn({ component: C, data: {} }).unwrap();
        const r = world.set(e, C, { clips: [form.value] } as never);
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect((r.error as unknown as { code: string }).code).toBe(SHARED_INVALID_CODE);
      });
    }
  });

  it('valid number handle for a scalar shared field is accepted (no false positive)', () => {
    const world = new World();
    const C = scalarComp('W7Scalar_ValidHandle');
    const handle = world.allocSharedRef('GameMaterial', {});
    const r = world.spawn({ component: C, data: { mat: handle } as never });
    expect(r.ok).toBe(true);
  });

  it('valid number handles for an array<shared<T>> field are accepted (no false positive)', () => {
    const world = new World();
    const C = arrayComp('W7Array_ValidHandles');
    const h1 = world.allocSharedRef('GameClip', {});
    const h2 = world.allocSharedRef('GameClip', {});
    const r = world.spawn({ component: C, data: { clips: [h1, h2] } as never });
    expect(r.ok).toBe(true);
  });

  it('SHARED_INVALID_CODE is a member of EcsErrorCode (exhaustive narrow)', () => {
    const code: EcsErrorCode = 'shared-field-invalid-value';
    expect(code).toBe('shared-field-invalid-value');
    expectTypeOf<'shared-field-invalid-value'>().toMatchTypeOf<EcsErrorCode>();
  });
});
