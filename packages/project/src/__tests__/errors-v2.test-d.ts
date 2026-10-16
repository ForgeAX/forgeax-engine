import { expectTypeOf, it } from 'vitest';
import type { GameProjectError, GameProjectErrorCode } from '../errors.js';
import { GameProjectError as GameProjectErrorClass } from '../errors.js';

const projectErrorCodes = [
  'forge-missing',
  'forge-parse-failed',
  'forge-schema-invalid',
  'forge-unknown-field',
  'forge-guid-malformed',
  'forge-scene-unresolved',
] as const;

expectTypeOf<GameProjectErrorCode>().toEqualTypeOf<(typeof projectErrorCodes)[number]>();

const errors: GameProjectError[] = [
  new GameProjectErrorClass({
    code: 'forge-schema-invalid',
    expected: 'forge.json to satisfy schema 2.0',
    hint: 'remove the legacy field and validate the manifest again',
    detail: { path: 'forge.json', zodErrors: [] },
  }),
  new GameProjectErrorClass({
    code: 'forge-unknown-field',
    expected: 'only schema 2.0 fields',
    hint: 'remove the unknown field',
    detail: { path: 'forge.json', fieldNames: ['entry'] },
  }),
];

function describe(error: GameProjectError): string {
  switch (error.code) {
    case 'forge-missing':
      return error.detail.path;
    case 'forge-parse-failed':
      return error.detail.rawMessage;
    case 'forge-schema-invalid':
      return `${error.detail.path}:${error.detail.zodErrors.length}`;
    case 'forge-unknown-field':
      return error.detail.fieldNames.join(',');
    case 'forge-guid-malformed':
      return error.detail.rawInput;
    case 'forge-scene-unresolved':
      return error.detail.guid;
  }
}

it('keeps project failures as a closed code/expected/hint/detail union', () => {
  for (const error of errors) {
    expectTypeOf(error.code).toEqualTypeOf<GameProjectErrorCode>();
    expectTypeOf(error.expected).toBeString();
    expectTypeOf(error.hint).toBeString();
    expectTypeOf(error.detail).toMatchTypeOf<object>();
  }
  void describe;
});
