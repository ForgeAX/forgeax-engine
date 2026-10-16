/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  PreviewSubject,
  PreviewSubjectKind,
  PreviewSubjectKind as PublicPreviewSubjectKind,
} from '../index.js';

type ExpectedSubjectKind = 'material' | 'mesh' | 'vfx' | 'texture';
const presentationSource = readFileSync(new URL('../kit/presentation.ts', import.meta.url), 'utf8');

describe('preview subject kind owner', () => {
  it('keeps the subject discriminant and public projection equal', () => {
    expectTypeOf<PreviewSubject['kind']>().toEqualTypeOf<ExpectedSubjectKind>();
    expectTypeOf<ExpectedSubjectKind>().toEqualTypeOf<PreviewSubject['kind']>();
    expectTypeOf<PreviewSubjectKind>().toEqualTypeOf<PreviewSubject['kind']>();
    expectTypeOf<PreviewSubject['kind']>().toEqualTypeOf<PreviewSubjectKind>();
    expectTypeOf<PublicPreviewSubjectKind>().toEqualTypeOf<PreviewSubjectKind>();

    const acceptsKind = (kind: PreviewSubjectKind): PreviewSubjectKind => kind;
    acceptsKind('material');
    acceptsKind('mesh');
    acceptsKind('vfx');
    acceptsKind('texture');
    // @ts-expect-error Unknown subject kinds remain outside the closed subject union.
    acceptsKind('subject-kind-not-real');
  });

  it('keeps PreviewSubjectKind derived from the subject owner', () => {
    expect(presentationSource).toContain(
      "export type PreviewSubjectKind = PreviewSubject['kind'];",
    );
    expect(presentationSource).not.toContain(
      "export type PreviewSubjectKind = 'material' | 'mesh' | 'vfx' | 'texture';",
    );
  });
});
