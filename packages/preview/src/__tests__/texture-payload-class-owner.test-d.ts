/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { inspectTextureSubject, TextureSubjectInspection } from '../domains/texture.js';
import type { TextureOracleInput } from '../evidence/oracle.js';

type OraclePayloadClass = TextureOracleInput['observed']['payloadClass'];
type InspectionPayloadClass = TextureSubjectInspection['payloadClass'];
type InspectedPayloadClass = Extract<
  ReturnType<typeof inspectTextureSubject>,
  { readonly ok: true }
>['value']['payloadClass'];
type ExpectedPayloadClass = 'black' | 'transparent' | 'single-channel' | 'color';

const textureSource = readFileSync(new URL('../domains/texture.ts', import.meta.url), 'utf8');

describe('texture payload class owner', () => {
  it('keeps the exact owner vocabulary and every texture projection equal', () => {
    expectTypeOf<OraclePayloadClass>().toEqualTypeOf<ExpectedPayloadClass>();
    expectTypeOf<ExpectedPayloadClass>().toEqualTypeOf<OraclePayloadClass>();
    expectTypeOf<InspectionPayloadClass>().toEqualTypeOf<OraclePayloadClass>();
    expectTypeOf<OraclePayloadClass>().toEqualTypeOf<InspectionPayloadClass>();
    expectTypeOf<InspectedPayloadClass>().toEqualTypeOf<OraclePayloadClass>();
    expectTypeOf<OraclePayloadClass>().toEqualTypeOf<InspectedPayloadClass>();

    const acceptsPayloadClass = (value: OraclePayloadClass): OraclePayloadClass => value;
    acceptsPayloadClass('black');
    acceptsPayloadClass('transparent');
    acceptsPayloadClass('single-channel');
    acceptsPayloadClass('color');
    // @ts-expect-error Unknown payload classes remain outside the closed oracle vocabulary.
    acceptsPayloadClass('unknown');
  });

  it('keeps the texture domain derived from the oracle owner without a repeated type ledger', () => {
    expect(textureSource).toContain(
      "readonly payloadClass: TextureOracleInput['observed']['payloadClass'];",
    );
    expect(textureSource).toContain("value is TextureSubjectInspection['payloadClass']");
    expect(textureSource).not.toContain(
      "readonly payloadClass: 'black' | 'transparent' | 'single-channel' | 'color';",
    );
    expect(textureSource).not.toContain("payloadClass as TextureSubjectInspection['payloadClass']");
  });
});
