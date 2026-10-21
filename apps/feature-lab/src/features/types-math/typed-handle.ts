import {
  type Handle,
  handleGeneration,
  handleSlot,
  pack,
  toShared,
  toUnique,
  unwrapHandle,
} from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';

type GameDataTag = 'GameData';

function acceptSharedData(handle: Handle<'GameData', 'shared'>): number {
  return unwrapHandle(handle);
}

export default defineFeature({
  title: 'Typed Handle brand',
  catalog: 'Typed Handle',
  kind: 'headless',
  summary:
    'Handle<Target, unique|shared> is a branded number: the target tag and release mode are compile-time facts with zero runtime cost.',
  expect:
    'All checks pass; mixing unique/shared or different data handles is a TypeScript error enforced by @ts-expect-error lines in this module.',
  run(checks) {
    const raw = pack(5, 3);
    const shared = toShared<GameDataTag>(raw);
    const unique = toUnique<'OtherData'>(raw);
    checks.ok('handle is a plain number at runtime', typeof shared === 'number');
    checks.equal('unwrapHandle is identity', unwrapHandle(shared), raw);
    checks.equal('slot decoded', handleSlot(shared), 5);
    checks.equal('generation decoded', handleGeneration(shared), 3);
    checks.equal('shared game data accepted', acceptSharedData(shared), raw);
    // @ts-expect-error unique handle must not flow into a shared-mode parameter
    acceptSharedData(toUnique<'GameData'>(raw));
    // @ts-expect-error other data handle must not flow into a game data parameter
    acceptSharedData(toShared<'OtherData'>(raw));
    checks.ok('unique and shared brands differ only in types', Number(unique) === Number(shared));
    const mesh: GameDataTag = 'GameData';
    checks.equal('target tag identifies game-owned data', mesh, 'GameData');
  },
});
