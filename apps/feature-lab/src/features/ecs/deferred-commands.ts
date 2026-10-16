import { defineComponent, Update, World } from '@forgeax/engine/ecs';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'Deferred structural commands',
  catalog: 'Deferred commands',
  kind: 'headless',
  summary:
    'Systems queue spawn/despawn/addComponent/removeComponent on a CommandBuffer; the World commits after the system, and an expected failure commits nothing.',
  expect:
    'All checks pass: queued changes are invisible inside the system, visible after update, and a duplicate addComponent returns command-failed while the World stays healthy and unchanged.',
  run(checks) {
    const Ammo = defineComponent('FLCmdAmmo', { n: 'u32' });
    const Bullet = defineComponent('FLCmdBullet', { dmg: 'f32' });
    const world = new World();
    const gun = world.spawn({ component: Ammo, data: { n: 3 } }).unwrap();
    let seenInside = -1;
    let deferred = false;
    world.addSystem(Update, {
      name: 'fl-cmd-fire',
      queries: [{ read: [Ammo] }],
      fn: (world, [guns], commands) => {
        for (const row of guns) {
          const pending = commands.spawn({ component: Bullet, data: { dmg: 5 } });
          deferred = commands.isDeferred(pending);
          commands.removeComponent(row.entity, Ammo);
        }
        seenInside = [...world.query({ read: [Bullet] }).unwrap()].length;
      },
    });
    checks.ok('update ok', world.update(1 / 60).ok);
    checks.equal('bullet not visible inside system', seenInside, 0);
    checks.ok('pending handle marked deferred', deferred);
    checks.equal(
      'bullet committed after system',
      [...world.query({ read: [Bullet] }).unwrap()].length,
      1,
    );
    checks.ok('removeComponent committed', !world.hasComponent(gun, Ammo));

    const bad = new World();
    const e = bad.spawn({ component: Ammo, data: { n: 1 } }).unwrap();
    bad.addSystem(Update, {
      name: 'fl-cmd-dup',
      queries: [],
      fn: (_world, _r, commands) => {
        commands.spawn({ component: Bullet, data: { dmg: 1 } });
        commands.addComponent(e, { component: Ammo, data: { n: 2 } });
      },
    });
    const before = bad.inspect().entityCount;
    const failed = bad.update(1 / 60);
    checks.equal(
      'duplicate add -> command-failed',
      failed.ok ? 'ok' : failed.error.code,
      'command-failed',
    );
    if (!failed.ok && failed.error.code === 'command-failed') {
      const cause = failed.error.detail.cause as { code?: string } | undefined;
      checks.equal('cause code', cause?.code, 'component-already-present');
      checks.equal('detail.commandKind', failed.error.detail.commandKind, 'addComponent');
    }
    checks.equal('World still healthy', bad.execution.health, 'healthy');
    checks.equal('no partial spawn committed', bad.inspect().entityCount, before);
    checks.equal('existing value untouched', bad.get(e, Ammo).unwrap().n, 1);
  },
});
