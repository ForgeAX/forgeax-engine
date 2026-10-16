import { DEFAULT_STANDARD_PROFILE, type RenderProfile } from '@forgeax/engine/render';
import { CheckList, defineFeature } from '../../lab/feature';
import { spawnStage } from '../../lab/stage';

export default defineFeature({
  title: 'URP/HDRP parity configuration',
  catalog: 'URP/HDRP parity asset configuration',
  kind: 'probe',
  summary:
    'forgeax::urp and forgeax::hdrp exist only in parity fixtures. The public facade refuses them at setProfile, and the running pipeline stays forgeax::standard.',
  expect:
    "All checks pass: both IDs are refused with 'frame-input-invalid' (operation set-profile) and the active pipeline remains 'forgeax::standard'. The actual parity comparison is a manual CI gate (see the manual).",
  async setup({ app, world, frames }) {
    spawnStage(world);
    await frames(2);
    return {
      checks() {
        const checks = new CheckList();
        for (const id of ['forgeax::urp', 'forgeax::hdrp']) {
          const result = app.renderer.setProfile({
            ...DEFAULT_STANDARD_PROFILE,
            pipelineId: id,
          } as unknown as RenderProfile);
          checks.equal(
            `${id} refused`,
            result.ok ? 'accepted' : result.error.code,
            'frame-input-invalid',
          );
        }
        return checks.equal(
          'active pipeline unchanged',
          app.renderer.inspect().profile.pipelineId,
          'forgeax::standard',
        ).items;
      },
    };
  },
});
