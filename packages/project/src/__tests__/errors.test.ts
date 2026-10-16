// errors.test.ts — w3: GameProjectError code union exhaustive tests
import { describe, expect, it } from 'vitest';
import type { GameProjectErrorCode, GameProjectErrorDetail } from '../errors.js';
import { GameProjectError } from '../errors.js';

// ── helper ───────────────────────────────────────────────────────────────────
function makeErr(): GameProjectError {
  return new GameProjectError({
    code: 'forge-missing',
    expected: 'test expected',
    hint: 'test hint',
    detail: { path: '/fake/forge.json' },
  });
}

const errors: GameProjectError[] = [
  new GameProjectError({
    code: 'forge-missing',
    expected: 'test expected',
    hint: 'test hint',
    detail: { path: '/fake/forge.json' },
  }),
  new GameProjectError({
    code: 'forge-parse-failed',
    expected: 'test expected',
    hint: 'test hint',
    detail: { path: '/fake/forge.json', rawMessage: 'invalid JSON' },
  }),
  new GameProjectError({
    code: 'forge-schema-invalid',
    expected: 'test expected',
    hint: 'test hint',
    detail: { path: '/fake/forge.json', zodErrors: [] },
  }),
  new GameProjectError({
    code: 'forge-unknown-field',
    expected: 'test expected',
    hint: 'test hint',
    detail: { path: '/fake/forge.json', fieldNames: ['scenes'] },
  }),
  new GameProjectError({
    code: 'forge-guid-malformed',
    expected: 'test expected',
    hint: 'test hint',
    detail: { field: 'defaultScene', rawInput: 'bad-guid', cause: new Error('bad GUID') },
  }),
  new GameProjectError({
    code: 'forge-scene-unresolved',
    expected: 'test expected',
    hint: 'test hint',
    detail: { guid: '15acc839-d847-527c-8284-bfb36d7c50de' },
  }),
];

// ── four-property surface ───────────────────────────────────────────────────
describe('GameProjectError — structural surface', () => {
  it('has .code, .expected, .hint, .detail', () => {
    const err = makeErr();
    expect(err).toHaveProperty('code');
    expect(err).toHaveProperty('expected');
    expect(err).toHaveProperty('hint');
    expect(err).toHaveProperty('detail');
  });

  it('.code is readonly (TS compile-time, not runtime)', () => {
    const err = makeErr();
    // TS `readonly` is compile-time only; at runtime the property exists and
    // holds its value. AI users cannot assign via the type (charter P2).
    expect(err.code).toBe('forge-missing');
    expect(typeof err.code).toBe('string');
  });

  it('.expected is readonly (TS compile-time)', () => {
    const err = makeErr();
    expect(err.expected).toBe('test expected');
    expect(typeof err.expected).toBe('string');
  });

  it('.hint is readonly (TS compile-time)', () => {
    const err = makeErr();
    expect(err.hint).toBe('test hint');
    expect(typeof err.hint).toBe('string');
  });

  it('.detail is readonly (TS compile-time)', () => {
    const err = makeErr();
    expect(err.detail).toBeDefined();
    expect(typeof err.detail).toBe('object');
  });
});

// ── code union membership ───────────────────────────────────────────────────
describe('GameProjectError — code union', () => {
  const codes: GameProjectErrorCode[] = [
    'forge-missing',
    'forge-parse-failed',
    'forge-schema-invalid',
    'forge-unknown-field',
    'forge-guid-malformed',
    'forge-scene-unresolved',
  ];

  it('code union has exactly 6 members', () => {
    expect(codes).toHaveLength(6);
  });

  it('each code is constructable', () => {
    expect(errors.map((error) => error.code)).toEqual(codes);
    for (const err of errors) {
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(GameProjectError);
    }
  });

  it('compiles exhaustive switch without default', () => {
    function switchOnCode(code: GameProjectErrorCode): string {
      switch (code) {
        case 'forge-missing':
          return 'missing';
        case 'forge-parse-failed':
          return 'parse-failed';
        case 'forge-schema-invalid':
          return 'schema-invalid';
        case 'forge-unknown-field':
          return 'unknown-field';
        case 'forge-guid-malformed':
          return 'guid-malformed';
        case 'forge-scene-unresolved':
          return 'scene-unresolved';
      }
    }
    expect(switchOnCode('forge-missing')).toBe('missing');
    expect(switchOnCode('forge-scene-unresolved')).toBe('scene-unresolved');
  });
});

function describeError(error: GameProjectError): string {
  switch (error.code) {
    case 'forge-missing':
      return `missing:${error.detail.path}`;
    case 'forge-parse-failed':
      return `parse:${error.detail.path}:${error.detail.rawMessage}`;
    case 'forge-schema-invalid':
      return `schema:${error.detail.path}:${error.detail.zodErrors.length}`;
    case 'forge-unknown-field':
      return `unknown:${error.detail.path}:${error.detail.fieldNames.join(',')}`;
    case 'forge-guid-malformed':
      return `guid:${error.detail.field}:${error.detail.rawInput}`;
    case 'forge-scene-unresolved':
      return `scene:${error.detail.guid}`;
  }
}

describe('GameProjectError — code-correlated error narrowing', () => {
  it('narrows representative detail payloads from error.code', () => {
    expect(errors.map(describeError)).toEqual([
      'missing:/fake/forge.json',
      'parse:/fake/forge.json:invalid JSON',
      'schema:/fake/forge.json:0',
      'unknown:/fake/forge.json:scenes',
      'guid:defaultScene:bad-guid',
      'scene:15acc839-d847-527c-8284-bfb36d7c50de',
    ]);
  });
});

// ── per-code detail narrowing ───────────────────────────────────────────────
describe('GameProjectError — detail narrowing per code', () => {
  it('forge-missing detail contains path:string', () => {
    const _detail: Extract<GameProjectErrorDetail, { path: string }> = {
      path: '/some/game/forge.json',
    };
    expect(_detail.path).toBe('/some/game/forge.json');
  });

  it('forge-parse-failed detail contains path + rawMessage', () => {
    const _detail: Extract<GameProjectErrorDetail, { path: string; rawMessage: string }> = {
      path: '/some/forge.json',
      rawMessage: 'Unexpected token',
    };
    expect(_detail.rawMessage).toBe('Unexpected token');
  });

  it('forge-schema-invalid detail contains path + zodErrors', () => {
    const _detail: Extract<GameProjectErrorDetail, { path: string; zodErrors: unknown }> = {
      path: '/some/forge.json',
      zodErrors: [],
    };
    expect(_detail.path).toBe('/some/forge.json');
  });

  it('forge-unknown-field detail contains path + fieldNames', () => {
    const _detail: Extract<GameProjectErrorDetail, { path: string; fieldNames: string[] }> = {
      path: '/some/forge.json',
      fieldNames: ['scenes'],
    };
    expect(_detail.fieldNames).toEqual(['scenes']);
  });

  it('forge-guid-malformed detail contains field + rawInput', () => {
    const _detail: Extract<GameProjectErrorDetail, { field: string; rawInput: string }> = {
      field: 'defaultScene',
      rawInput: 'rogue-encampment',
    };
    expect(_detail.rawInput).toBe('rogue-encampment');
  });

  it('forge-scene-unresolved detail contains guid:string', () => {
    const _detail: Extract<GameProjectErrorDetail, { guid: string }> = {
      guid: '15acc839-d847-527c-8284-bfb36d7c50de',
    };
    expect(_detail.guid).toBe('15acc839-d847-527c-8284-bfb36d7c50de');
  });
});

// ── error message ───────────────────────────────────────────────────────────
describe('GameProjectError — message', () => {
  it('is an instance of Error', () => {
    const err = makeErr();
    expect(err).toBeInstanceOf(Error);
  });

  it('has name GameProjectError', () => {
    const err = makeErr();
    expect(err.name).toBe('GameProjectError');
  });

  it('message contains code for human readability', () => {
    const err = makeErr();
    expect(err.message).toContain('GameProjectError');
    expect(err.message).toContain('forge-missing');
  });
});
