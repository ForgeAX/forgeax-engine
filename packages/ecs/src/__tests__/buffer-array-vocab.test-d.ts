// Compile-time type-derivation tests for the SchemaVocabKeyword closed union
// after the M1 buffer/array vocab collapse (w1, AC-01).
//
// Locks the new closed-union surface: the legacy `'buffer:<N>'` literal is
// retired one-cut by feat-20260515-buffer-array-vocab-collapse w4, replaced
// by the angle-bracket generic shapes `'buffer'` / `'buffer<N>'`. The new
// vocab forms a 4-keyword closed surface across two orthogonal axes:
//
//   element-type axis  | byte-only       | typed
//   --------------------------------------------------
//   variable capacity  | 'buffer'        | 'array<T>'
//   fixed capacity     | 'buffer<N>'     | 'array<T, N>'
//
// Negative anchors:
//   - `'buffer:8'` is NO LONGER a SchemaVocabKeyword (TS error)
//
// Positive anchors:
//   - `'buffer'`        is a SchemaVocabKeyword (compiles)
//   - `'buffer<8>'`     is a SchemaVocabKeyword (compiles)
//   - `'array<f32, 16>'` is a SchemaVocabKeyword (compiles)
//   - `'array<entity>'`  is a SchemaVocabKeyword (compiles)

import { describe, it } from 'vitest';
import type { SchemaVocabKeyword } from '../component';

describe('schema vocab — buffer-array-collapse closed union (w1, AC-01)', () => {
  it('legacy buffer:<N> literal is rejected', () => {
    // @ts-expect-error 'buffer:8' is no longer a SchemaVocabKeyword (collapsed
    // to 'buffer<8>' by feat-20260515 w4).
    const bad: SchemaVocabKeyword = 'buffer:8';
    void bad;
  });

  it("'buffer' (variable capacity) is a SchemaVocabKeyword", () => {
    const good: SchemaVocabKeyword = 'buffer';
    void good;
  });

  it("'buffer<N>' (fixed capacity) is a SchemaVocabKeyword", () => {
    const good: SchemaVocabKeyword = 'buffer<8>';
    void good;
  });

  it("'array<T, N>' (typed fixed) is a SchemaVocabKeyword", () => {
    const good: SchemaVocabKeyword = 'array<f32, 16>';
    void good;
  });

  it("'array<entity>' (entity variable) is a SchemaVocabKeyword", () => {
    const good: SchemaVocabKeyword = 'array<entity>';
    void good;
  });
});
