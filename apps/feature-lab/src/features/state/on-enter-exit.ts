import { World } from '@forgeax/engine/ecs';
import {
  addOnEnter,
  addOnExit,
  defineState,
  OnEnter,
  OnExit,
  registerStatesPlugin,
  setNextState,
} from '@forgeax/engine/state';
import { defineFeature } from '../../lab/feature';

const FLHookDoor = defineState('FLHookDoor', ['closed', 'open', 'locked'] as const);

export default defineFeature({
  title: 'OnEnter/OnExit hooks',
  catalog: 'OnEnter/OnExit hooks',
  kind: 'headless',
  summary:
    'addOnEnter/addOnExit register per-variant callbacks; OnExit(prev) runs before OnEnter(next) and unsubscribe stops delivery.',
  expect:
    'All checks pass: the log shows exit then enter in order, labels are stable strings, unsubscribed hooks stop firing, and a throwing hook propagates as system-failed.',
  run(checks) {
    const world = new World();
    const dispose = registerStatesPlugin(world);
    const log: string[] = [];
    const offs = [
      addOnExit(FLHookDoor, 'closed', () => void log.push('exit:closed')),
      addOnEnter(FLHookDoor, 'open', () => void log.push('enter:open')),
      addOnExit(FLHookDoor, 'open', () => void log.push('exit:open')),
      addOnEnter(FLHookDoor, 'closed', () => void log.push('enter:closed')),
    ];
    checks.equal('OnEnter label', typeof OnEnter(FLHookDoor, 'open'), 'string');
    checks.ok('labels differ', OnEnter(FLHookDoor, 'open') !== OnExit(FLHookDoor, 'open'));
    checks.equal('label is stable', OnEnter(FLHookDoor, 'open'), OnEnter(FLHookDoor, 'open'));
    setNextState(world, FLHookDoor, 'open');
    world.update(1 / 60);
    checks.equal('exit before enter', log, ['exit:closed', 'enter:open']);
    for (const off of offs) off();
    setNextState(world, FLHookDoor, 'closed');
    world.update(1 / 60);
    checks.equal('unsubscribed hooks silent', log.length, 2);
    const offLock = addOnEnter(FLHookDoor, 'locked', () => {
      throw new Error('fl lock failed');
    });
    setNextState(world, FLHookDoor, 'locked');
    const failed = world.update(1 / 60);
    checks.equal('hook error bubbles', failed.ok ? 'ok' : failed.error.code, 'system-failed');
    offLock();
    dispose();
  },
});
