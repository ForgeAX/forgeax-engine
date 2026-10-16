import { LAB_EFFECT_GUID, LAB_EMITTER_IDS } from './support/lab-effect';
import { check, vfxProbe } from './support/probe';
import { loadLabEffect } from './support/vfx-stage';

export default vfxProbe(
  {
    title: 'VFX ECS player',
    catalog: 'VFX ECS player',
    summary:
      'A ParticleEffectPlayer component on an ordinary entity references a shared ParticleEffectAsset loaded through the owner Pack loader; the runtime keys inspection by player handle, asset GUID and emitter ID.',
    expect:
      'host.inspect lists one playing player with the lab GUID and all five emitters, phaseTick advances with fixed ticks, and a tampered fingerprint is refused by the loader.',
  },
  async (vfx, { frames }) => {
    const before = vfx.host.inspect(vfx.world)?.players[0];
    await frames(20);
    const after = vfx.host.inspect(vfx.world)?.players[0];
    const tick = (snapshot: typeof before) => snapshot?.emitters[0]?.phaseTick ?? -1;
    const stale = `sha256:${'0'.repeat(64)}`;
    const tampered = await loadLabEffect((payload) => ({
      ...payload,
      programFingerprint: stale,
      program: { ...(payload.program as Record<string, unknown>), fingerprint: stale },
    }));
    const v2 = await loadLabEffect((payload) => ({ ...payload, schemaVersion: 2 }));
    return [
      check('one player inspected', vfx.host.inspect(vfx.world)?.players.length === 1),
      check('player handle matches the spawned entity', after?.player === vfx.player),
      check('asset GUID is the lab effect', after?.assetGuid === LAB_EFFECT_GUID, after?.assetGuid),
      check('player is playing', after?.playing === true),
      check(
        'five emitters keyed by ID',
        after?.emitters.map((emitter) => emitter.id).join(',') ===
          Object.values(LAB_EMITTER_IDS).join(','),
        after?.emitters.map((emitter) => emitter.id),
      ),
      check('phaseTick advances with fixed ticks', tick(after) > tick(before), {
        before: tick(before),
        after: tick(after),
      }),
      check(
        'loader refuses a tampered fingerprint',
        !tampered.ok && tampered.error.code === 'vfx-asset-v3-fingerprint-mismatch',
        tampered.ok ? 'accepted' : tampered.error.code,
      ),
      check(
        'loader refuses schemaVersion 2',
        !v2.ok && v2.error.code === 'vfx-asset-version-unsupported',
        v2.ok ? 'accepted' : v2.error.code,
      ),
    ];
  },
);
