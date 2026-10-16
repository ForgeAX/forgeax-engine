import type { GameProjectError as GameProjectErrorType } from '../index.js';
import { GameProjectError } from '../index.js';

const positiveErrors: GameProjectErrorType[] = [
  new GameProjectError({
    code: 'forge-missing',
    expected: 'forge.json to exist',
    hint: 'create forge.json',
    detail: { path: 'forge.json' },
  }),
  new GameProjectError({
    code: 'forge-parse-failed',
    expected: 'valid JSON',
    hint: 'fix JSON',
    detail: { path: 'forge.json', rawMessage: 'Unexpected token' },
  }),
  new GameProjectError({
    code: 'forge-schema-invalid',
    expected: 'schema-valid JSON',
    hint: 'fix fields',
    detail: { path: 'forge.json', zodErrors: [] },
  }),
  new GameProjectError({
    code: 'forge-unknown-field',
    expected: 'known fields',
    hint: 'remove the field',
    detail: { path: 'forge.json', fieldNames: ['scenes'] },
  }),
  new GameProjectError({
    code: 'forge-guid-malformed',
    expected: 'a valid GUID',
    hint: 'use a scene GUID',
    detail: { field: 'defaultScene', rawInput: 'not-a-guid' },
  }),
  new GameProjectError({
    code: 'forge-scene-unresolved',
    expected: 'a resolvable scene',
    hint: 'check the scene pack',
    detail: { guid: '15acc839-d847-527c-8284-bfb36d7c50de' },
  }),
];

new GameProjectError({
  code: 'forge-guid-malformed',
  expected: 'a valid GUID',
  hint: 'use a scene GUID',
  // @ts-expect-error code/detail pairs remain correlated.
  detail: { path: 'forge.json' },
});

function describe(error: GameProjectErrorType): string {
  switch (error.code) {
    case 'forge-missing':
      return error.detail.path;
    case 'forge-parse-failed':
      return error.detail.rawMessage;
    case 'forge-schema-invalid':
      return String(error.detail.zodErrors.length);
    case 'forge-unknown-field':
      return error.detail.fieldNames.join(',');
    case 'forge-guid-malformed':
      return error.detail.rawInput;
    case 'forge-scene-unresolved':
      return error.detail.guid;
  }
}

void positiveErrors;
void describe;
