/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { DshRealmConnection } from '../engine-host.js';
import type { FederationBinding } from '../protocol.js';

type LaunchBinding = Exclude<FederationBinding, 'attach'>;
type ExpectedLaunchBinding = 'external' | 'embedded';
type ConnectionBinding = DshRealmConnection['binding'];

const engineHostSource = readFileSync(new URL('../engine-host.ts', import.meta.url), 'utf8');

describe('DSH launch binding owner', () => {
  it('keeps the launch projection exact and excludes attach', () => {
    expectTypeOf<LaunchBinding>().toEqualTypeOf<ExpectedLaunchBinding>();
    expectTypeOf<ExpectedLaunchBinding>().toEqualTypeOf<LaunchBinding>();

    const acceptsLaunchBinding = (binding: LaunchBinding): LaunchBinding => binding;
    acceptsLaunchBinding('external');
    acceptsLaunchBinding('embedded');
    // @ts-expect-error Launch owns only the non-attach FederationBinding projection.
    acceptsLaunchBinding('attach');
  });

  it('keeps the connection binding wider and derives finishLaunch from the owner', () => {
    expectTypeOf<ConnectionBinding>().toEqualTypeOf<FederationBinding>();
    expectTypeOf<FederationBinding>().toEqualTypeOf<ConnectionBinding>();

    expect(engineHostSource).toContain("binding: Exclude<FederationBinding, 'attach'>,");
    expect(engineHostSource).not.toContain("binding: 'external' | 'embedded',");
  });
});
