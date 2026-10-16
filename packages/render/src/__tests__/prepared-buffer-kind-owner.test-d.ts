import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { PreparedGraphicsKind } from '../features/prepared-graphics-store';
import type { PreparedGraphicsResolvedResource } from '../prepare/prepared-graphics-resolver';

type PreparedBufferKind = Exclude<PreparedGraphicsKind, 'pipeline' | 'bindings'>;
type PreparedBufferResource = Extract<
  PreparedGraphicsResolvedResource,
  { readonly kind: PreparedBufferKind }
>;

const resolverSource = readFileSync(
  new URL('../prepare/prepared-graphics-resolver.ts', import.meta.url),
  'utf8',
);

describe('prepared buffer kind owner', () => {
  it('keeps the buffer projection derived from PreparedGraphicsKind', () => {
    expectTypeOf<PreparedBufferKind>().toEqualTypeOf<'vertex-data' | 'index-data'>();
    expectTypeOf<PreparedBufferResource['kind']>().toEqualTypeOf<PreparedBufferKind>();
    expectTypeOf<PreparedBufferKind>().toEqualTypeOf<PreparedBufferResource['kind']>();
  });

  it('keeps the projection local to the resolver owner', () => {
    expect(resolverSource).toContain(
      "type PreparedBufferKind = Exclude<PreparedGraphicsKind, 'pipeline' | 'bindings'>;",
    );
  });
});
