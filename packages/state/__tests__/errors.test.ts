import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  InvalidVariantDetail,
  StateAlreadyDefinedDetail,
  StateDefaultRequiredDetail,
  StateError,
  StateErrorCode,
  StateErrorDetail,
  StateNotRegisteredDetail,
} from '../src/errors';
import {
  invalidVariant,
  stateNotRegistered,
  throwStateError,
} from '../src/errors';

describe('StateError code/detail correlation', () => {
  it('accepts every existing code with its matching detail', () => {
    if (false) {
      throwStateError('state-already-defined', '', '', {
        name: 'GameState',
        firstDefinedAt: undefined,
      });
      throwStateError('state-not-registered', '', '', {
        name: 'GameState',
      });
      throwStateError('invalid-variant', '', '', {
        name: 'GameState',
        got: 'missing',
        valid: ['idle'],
      });
      throwStateError('state-default-required', '', '', {
        name: 'GameState',
      });
    }

    const details: StateErrorDetail[] = [
      {
        name: 'GameState',
        firstDefinedAt: undefined,
      },
      { name: 'GameState' },
      { name: 'GameState', got: 'missing', valid: ['idle'] },
      { name: 'GameState' },
    ];
    expect(details).toHaveLength(4);
  });

  it('rejects mismatched code/detail pairs', () => {
    if (false) {
      throwStateError(
        'invalid-variant',
        '',
        '',
        // @ts-expect-error -- invalid-variant requires its own detail payload.
        { name: 'GameState' },
      );
    }

    expect(true).toBe(true);
  });

  it('narrows detail from an exhaustive code switch', () => {
    function describeError(error: StateError): string {
      switch (error.code) {
        case 'state-already-defined':
          expectTypeOf(error.detail).toEqualTypeOf<StateAlreadyDefinedDetail>();
          return `${error.detail.name}:${error.detail.firstDefinedAt ?? ''}`;
        case 'state-not-registered':
          expectTypeOf(error.detail).toEqualTypeOf<StateNotRegisteredDetail>();
          return error.detail.name;
        case 'invalid-variant':
          expectTypeOf(error.detail).toEqualTypeOf<InvalidVariantDetail>();
          return `${error.detail.name}:${error.detail.got}/${error.detail.valid.join(',')}`;
        case 'state-default-required':
          expectTypeOf(error.detail).toEqualTypeOf<StateDefaultRequiredDetail>();
          return error.detail.name;
      }
    }

    expect(describeError(stateNotRegistered('GameState'))).toContain('GameState');
    expectTypeOf<StateErrorCode>().toEqualTypeOf<
      | 'state-already-defined'
      | 'state-not-registered'
      | 'invalid-variant'
      | 'state-default-required'
    >();
    expectTypeOf<StateErrorDetail>().toEqualTypeOf<
      | StateAlreadyDefinedDetail
      | StateNotRegisteredDetail
      | InvalidVariantDetail
      | StateDefaultRequiredDetail
    >();
  });

  it('preserves the runtime envelope and snapshots invalid variants', () => {
    const variants = ['idle'];
    const snapshot = invalidVariant('GameState', 'missing', variants);
    variants.push('later');
    expect(snapshot.detail).toEqual({ name: 'GameState', got: 'missing', valid: ['idle'] });
    const errors: StateError[] = [
      stateNotRegistered('GameState'),
      invalidVariant('GameState', 'missing', ['idle']),
    ];

    for (const error of errors) {
      expect(error.detail.name).toBe('GameState');
      expect(error.expected).toBeTypeOf('string');
      expect(error.hint).toBeTypeOf('string');
      expect(Object.getOwnPropertyDescriptor(error, 'message')?.get).toBeTypeOf('function');
      expect(Reflect.get(error, 'message')).toBe(`[${error.code}] ${error.hint}`);
    }
  });
});
