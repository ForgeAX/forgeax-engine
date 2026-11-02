import { expect, it } from 'vitest';
import {
  captureShadowViewIdentity,
  directionalShadowViewIdentity,
  shadowViewIdentityKey,
  staticShadowViewIdentity,
} from '../gpu-driven/shadow-view-identity';

it('keeps owned logical identities and static children detached and stable', () => {
  const source = {
    kind: 'directional' as const,
    index: 2,
    terrainReceiver: { worldId: 1, entityKey: 7 },
  };
  const owned = captureShadowViewIdentity(source);
  const child = staticShadowViewIdentity(owned);
  const key = shadowViewIdentityKey(owned);
  source.index = 3;
  source.terrainReceiver.entityKey = 8;
  expect(shadowViewIdentityKey(owned)).toBe(key);
  expect(shadowViewIdentityKey(source)).not.toBe(key);
  expect(captureShadowViewIdentity(owned)).toBe(owned);
  expect(staticShadowViewIdentity(owned)).toBe(child);
  expect(staticShadowViewIdentity(child)).toBe(child);
  expect(child.terrainReceiver).toEqual({ worldId: 1, entityKey: 7 });
  expect(Object.isFrozen(child.terrainReceiver)).toBe(true);
  expect(shadowViewIdentityKey(child)).toBe('directional:2::static:terrain:1:7');
});

it('observes borrowed getters, nested mutation and spread fields on every read', () => {
  let index = 0;
  let reads = 0;
  const terrainReceiver = { worldId: 2, entityKey: 3 };
  const source = Object.freeze({
    kind: 'spot' as const,
    get index() {
      reads++;
      return index;
    },
    terrainReceiver,
    extra: 9,
  });
  expect(shadowViewIdentityKey(source)).toBe('spot:0::terrain:2:3');
  index = 1;
  terrainReceiver.entityKey = 4;
  expect(shadowViewIdentityKey(source)).toBe('spot:1::terrain:2:4');
  const first = staticShadowViewIdentity(source);
  const second = staticShadowViewIdentity(source);
  expect(first).not.toBe(second);
  expect(first).toMatchObject({ index: 1, layer: 'static', extra: 9 });
  expect(reads).toBe(4);
});

it('shares only the four closed directional definitions across producers', () => {
  for (let i = 0; i < 4; i++) {
    expect(directionalShadowViewIdentity(i)).toBe(directionalShadowViewIdentity(i));
    expect(staticShadowViewIdentity(directionalShadowViewIdentity(i))).toBe(
      staticShadowViewIdentity(directionalShadowViewIdentity(i)),
    );
  }
  expect(directionalShadowViewIdentity(99)).toEqual({ kind: 'directional', index: 99 });
});
