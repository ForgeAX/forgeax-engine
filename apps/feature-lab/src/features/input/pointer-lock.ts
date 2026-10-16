import { CheckList, defineFeature } from '../../lab/feature';
import { spawnStage } from '../../lab/stage';
import { privateBackend } from './support/private-backend';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export default defineFeature({
  title: 'Pointer Lock gates (lockProvider)',
  catalog: 'Pointer Lock',
  kind: 'probe',
  summary:
    'A canvas click asks the Host lockProvider for a lock only when the realm gate (setPointerLockAllowed) and the host predicate both allow it; the snapshot reports pointerLocked.',
  expect:
    'All checks pass: click locks, Escape releases, a closed gate or host predicate blocks the request, a rejected request rolls back pointerLocked. Real W3C lock needs a trusted click: see the manual doc.',
  setup({ world }) {
    spawnStage(world);
    return {
      async checks() {
        const c = new CheckList();
        const calls = { request: 0, exit: 0 };
        let hostAllows = true;
        let reject = false;
        const b = privateBackend({
          pointerLockAllowed: () => hostAllows,
          lockProvider: {
            requestLock() {
              calls.request += 1;
              return reject ? Promise.reject(new Error('fl denied')) : undefined;
            },
            exitLock() {
              calls.exit += 1;
            },
          },
        });
        c.ok('unlocked initially', !b.step().mouse.pointerLocked);
        b.canvas.dispatchEvent(new MouseEvent('click'));
        c.equal('click requests provider lock', calls.request, 1);
        c.ok('snapshot pointerLocked after request', b.step().mouse.pointerLocked);
        b.key('keydown', 'Escape', 'Escape');
        c.equal('Escape calls exitLock', calls.exit, 1);
        c.ok('snapshot unlocked after Escape', !b.step().mouse.pointerLocked);
        b.backend.setPointerLockAllowed?.(false);
        b.canvas.dispatchEvent(new MouseEvent('click'));
        c.equal('realm gate false blocks request', calls.request, 1);
        b.backend.setPointerLockAllowed?.(true);
        hostAllows = false;
        b.canvas.dispatchEvent(new MouseEvent('click'));
        c.equal('host predicate false blocks request', calls.request, 1);
        hostAllows = true;
        reject = true;
        b.canvas.dispatchEvent(new MouseEvent('click'));
        await tick();
        c.equal('rejected request attempted', calls.request, 2);
        c.ok('rejection rolls back pointerLocked', !b.step().mouse.pointerLocked);
        b.dispose();
        return c.items;
      },
    };
  },
});
