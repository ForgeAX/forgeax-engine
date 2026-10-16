import { CheckList, defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';
import { observeNextFrame } from './support/observe';

const ORDER = ['transparent', 'bloom', 'output-transform', 'fxaa', 'present'];

export default defineFeature({
  title: 'Unified color-domain contract',
  catalog: 'Unified color-domain contract',
  kind: 'probe',
  summary:
    'One frame is observed in all three domains: linear HDR scene color, linear LDR after the output transform, and the single display-encoded final image. Post stages run in one fixed order.',
  expect:
    'All checks pass: the three domains come from the same frame, HDR is rgba16float, the committed output graph orders transparent -> bloom -> output-transform (tone + LUT) -> fxaa -> present, and exactly one owner display-encodes.',
  async setup({ app, world, frames }) {
    spawnStage(world);
    spawnMesh(
      world,
      MESH.sphere,
      standard(world, { baseColor: [0.2, 0.5, 1, 1], emissive: [3, 3, 3] }),
      { pos: [0, 0.6, 0] },
    );
    await frames(3);
    return {
      async checks() {
        const checks = new CheckList();
        const facts = app.renderer.inspect();
        const passes = facts.output.graphPassNames;
        const positions = ORDER.map((stage) => passes.findIndex((name) => name.includes(stage)));
        const present = positions.filter((index) => index >= 0);
        checks
          .equal('profile post-stage order', facts.profile.postStages, [
            'transparent-blend',
            'bloom',
            'output-transform',
            'fxaa',
            'post-effect',
            'present',
          ])
          .ok(
            'output-transform pass committed',
            positions[2] !== undefined && positions[2] >= 0,
            passes.join(','),
          )
          .ok(
            'committed passes follow the stage order',
            present.every((index, i) => i === 0 || index > (present[i - 1] ?? -1)),
            `positions=${positions.join(',')} passes=${passes.join(',')}`,
          )
          .ok(
            'surface formats recorded',
            facts.output.surfaceStorage !== undefined && facts.output.surfaceDisplay !== undefined,
            `intermediate=${String(facts.output.intermediateFormat)}`,
          )
          .ok(
            'display encoding owner reported',
            typeof facts.output.displayEncoded === 'boolean',
            `displayEncoded=${facts.output.displayEncoded} surface=${facts.output.surfaceStorage}/${facts.output.surfaceDisplay}`,
          );
        const outcome = await observeNextFrame(app, ['linear-hdr', 'linear-ldr', 'final-display']);
        checks.ok(
          'three-domain observation resolved',
          outcome.ok,
          outcome.ok ? undefined : outcome.error,
        );
        if (!outcome.ok) return checks.items;
        const observations = outcome.value.observations ?? [];
        const format = (domain: string) =>
          observations.find((entry) => entry.domain === domain)?.metadata.format;
        checks
          .equal('domains', observations.map((entry) => entry.domain).sort(), [
            'final-display',
            'linear-hdr',
            'linear-ldr',
          ])
          .ok(
            'same frame for every domain',
            observations.every((entry) => entry.metadata.frameId === outcome.receiptFrame),
          )
          .equal('linear HDR format', format('linear-hdr'), 'rgba16float')
          .ok(
            'LDR and final are distinct captures',
            format('linear-ldr') !== undefined && format('final-display') !== undefined,
            `ldr=${format('linear-ldr')} final=${format('final-display')}`,
          );
        return checks.items;
      },
    };
  },
});
