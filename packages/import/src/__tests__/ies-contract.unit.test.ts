import type { IesProfileAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { validateIesProfilePayload } from '../ies/ies-importer';

describe('IES asset contract', () => {
  it('accepts exactly one cooked Type C payload shape', () => {
    const payload: IesProfileAsset = {
      kind: 'ies-profile',
      data: new Uint8Array(256 * 128 * 2),
    };
    expect(validateIesProfilePayload(payload)).toEqual({ ok: true, value: payload });
  });

  it('rejects wrong kind, byte length, and non-finite decoded values', () => {
    expect(
      validateIesProfilePayload({ kind: 'texture', data: new Uint8Array(256 * 128 * 2) }),
    ).toMatchObject({
      ok: false,
    });
    expect(
      validateIesProfilePayload({ kind: 'ies-profile', data: new Uint8Array(4) }),
    ).toMatchObject({
      ok: false,
    });
    const nonFinite = new Uint8Array(256 * 128 * 2);
    nonFinite[1] = 0x7c;
    expect(validateIesProfilePayload({ kind: 'ies-profile', data: nonFinite })).toMatchObject({
      ok: false,
    });
  });
});
