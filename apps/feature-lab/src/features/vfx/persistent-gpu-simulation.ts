import { check, vfxProbe } from './support/probe';

export default vfxProbe(
  {
    title: 'Persistent GPU simulation',
    catalog: 'Persistent GPU simulation',
    summary:
      'Particle state lives in renderer-owned GPU buffers; each fixed tick becomes compute dispatches (spawn/update/compact) with no CPU particle mirror or readback.',
    expect:
      'The VFX feature reports compute dispatches every frame while playing; the tick counter keeps advancing; pausing render consumption stops the dispatches and resuming restarts them.',
  },
  async (vfx, { frames }) => {
    const playing = vfx.host.feature.inspect();
    const tickBefore = vfx.host.inspect(vfx.world)?.players[0]?.emitters[0]?.tick ?? -1;
    await frames(10);
    const tickAfter = vfx.host.inspect(vfx.world)?.players[0]?.emitters[0]?.tick ?? -1;
    const paused = vfx.control.setPlayerRenderConsumption({ player: vfx.player, enabled: false });
    await frames(6);
    const whilePaused = vfx.host.feature.inspect();
    const resumed = vfx.control.setPlayerRenderConsumption({ player: vfx.player, enabled: true });
    await frames(6);
    const afterResume = vfx.host.feature.inspect();
    return [
      check('compute dispatches while playing', playing.dispatches > 0, playing),
      check('simulation tick advances', tickAfter > tickBefore, { tickBefore, tickAfter }),
      check(
        'pause accepted',
        paused.ok && paused.value.state === 'paused',
        paused.ok ? paused.value : paused.error.code,
      ),
      check(
        'no dispatches while render consumption is paused',
        whilePaused.dispatches === 0,
        whilePaused,
      ),
      check(
        'resume accepted',
        resumed.ok && resumed.value.state === 'enabled',
        resumed.ok ? resumed.value : resumed.error.code,
      ),
      check('dispatches return after resume', afterResume.dispatches > 0, afterResume),
    ];
  },
);
