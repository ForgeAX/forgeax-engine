import type { EntityHandle } from '@forgeax/engine/ecs';
import { describeVfxGpuEffect, isVfxGpuEffectAsset } from '@forgeax/engine/vfx';
import { LAB_EFFECT_GUID } from './support/lab-effect';
import { check, vfxProbe } from './support/probe';
import { loadLabEffect } from './support/vfx-stage';

export default vfxProbe(
  {
    title: 'VFX inspection/LKG',
    catalog: 'VFX inspection/LKG',
    summary:
      'host.inspect(world) is a generation-keyed aggregate of players and emitters; host.acquireControl gives typed same-generation preview control (replay, session masks) with structured errors; describeVfxGpuEffect projects an effect for tools.',
    expect:
      'Inspection carries host and render generations; replay is queued for the live player and refused for a bogus player; the descriptor lists five emitters. Pack HMR last-known-good is a manual smoke (see doc).',
  },
  async (vfx, { frames }) => {
    const snapshot = vfx.host.inspect(vfx.world);
    const replay = vfx.control.replay({ player: vfx.player });
    await frames(4);
    const bogus = vfx.control.replay({ player: 987654 as unknown as EntityHandle });
    const loaded = await loadLabEffect();
    const descriptor =
      loaded.ok && isVfxGpuEffectAsset(loaded.value)
        ? describeVfxGpuEffect(loaded.value)
        : undefined;
    return [
      check('host generation is positive', (snapshot?.generation ?? 0) > 0, snapshot?.generation),
      check(
        'control generation matches inspection',
        vfx.control.generation === snapshot?.generation,
      ),
      check(
        'render generation present',
        typeof snapshot?.renderGeneration === 'number',
        snapshot?.renderGeneration,
      ),
      check('no runtime diagnostics', snapshot?.diagnostics.length === 0, snapshot?.diagnostics),
      check(
        'replay queued for the live player',
        replay.ok && replay.value.state === 'queued',
        replay.ok ? replay.value : replay.error.code,
      ),
      check(
        'replay of an unknown player refused',
        !bogus.ok && bogus.error.code === 'vfx-host-control-player-unavailable',
        bogus.ok ? 'accepted' : bogus.error.code,
      ),
      check(
        'descriptor asset GUID',
        descriptor?.assetGuid === LAB_EFFECT_GUID,
        descriptor?.assetGuid,
      ),
      check(
        'descriptor lists five emitters',
        descriptor?.emitters.length === 5,
        descriptor?.emitters.length,
      ),
    ];
  },
);
