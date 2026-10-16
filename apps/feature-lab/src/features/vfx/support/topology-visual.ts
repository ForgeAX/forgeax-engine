import { defineFeature } from '../../../lab/feature';
import { LAB_EMITTER_IDS, type LabEmitterKind } from './lab-effect';
import { createLabHost, setupLabVfx } from './vfx-stage';

/** Shared body for the five topology visuals: isolate one emitter and toggle its session mask. */
export function topologyVisual(
  kind: LabEmitterKind,
  meta: { title: string; catalog: string; summary: string; expect: string },
) {
  const lab = createLabHost();
  return defineFeature({
    ...meta,
    kind: 'visual',
    get appOptions() {
      return lab.appOptions;
    },
    async setup({ app, world, frames, hud }) {
      const setup = await setupLabVfx(lab, app, world);
      if (!setup.ok) {
        hud.status(setup.error);
        return { checks: () => [{ name: 'lab VFX setup', ok: false, detail: setup.error }] };
      }
      const vfx = setup.value;
      const isolated = vfx.only([kind]);
      await frames(20);
      return {
        async toggle(on: boolean) {
          vfx.control.setEmitterSessionEnabled({
            player: vfx.player,
            emitterId: LAB_EMITTER_IDS[kind],
            enabled: on,
          });
          await frames(20);
        },
        checks() {
          const emitter = vfx.host
            .inspect(world)
            ?.players[0]?.emitters.find((entry) => entry.id === LAB_EMITTER_IDS[kind]);
          return [
            { name: 'emitters isolated', ok: isolated === undefined, detail: isolated ?? 'ok' },
            {
              name: `${kind} emitter present with ${kind} renderer`,
              ok: emitter?.renderers[0]?.kind === kind,
              detail:
                emitter === undefined ? 'missing' : emitter.renderers.map((r) => r.kind).join(','),
            },
            {
              name: 'no render-feature failure',
              ok: vfx.lastFailure() === undefined,
              detail: vfx.lastFailure() ?? 'ok',
            },
            {
              name: 'observation has indirect draws',
              ok: vfx.host.feature.inspect().indirectDraws > 0,
            },
          ];
        },
      };
    },
  });
}
