/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { NpcClientPort } from '../index.js';

type NpcClientLodName = Parameters<NpcClientPort<unknown, unknown>['setLod']>[1];
type ExpectedNpcClientLodName = 'spotlight' | 'ambient' | 'offstage';

const npcSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

describe('NPC client LOD name owner', () => {
  it('keeps the external LOD vocabulary bilateral and closed', () => {
    expectTypeOf<NpcClientLodName>().toEqualTypeOf<ExpectedNpcClientLodName>();
    expectTypeOf<ExpectedNpcClientLodName>().toEqualTypeOf<NpcClientLodName>();

    const acceptsLodName = (name: NpcClientLodName): NpcClientLodName => name;
    acceptsLodName('spotlight');
    acceptsLodName('ambient');
    acceptsLodName('offstage');
    // @ts-expect-error Unknown external LOD names remain outside the closed vocabulary.
    acceptsLodName('lod-name-not-real');
  });

  it('projects the one named owner through the port and private mapping', () => {
    expect(npcSource).toContain("type NpcClientLodName = 'spotlight' | 'ambient' | 'offstage';");
    expect(npcSource).toContain('setLod(npcId: string, level: NpcClientLodName');
    expect(npcSource).toContain('function lodName(lod: NpcCognitiveLod): NpcClientLodName');
    expect(npcSource).not.toContain(
      "setLod(npcId: string, level: 'spotlight' | 'ambient' | 'offstage'",
    );
    expect(npcSource).not.toContain(
      "function lodName(lod: NpcCognitiveLod): 'spotlight' | 'ambient' | 'offstage'",
    );
  });
});
