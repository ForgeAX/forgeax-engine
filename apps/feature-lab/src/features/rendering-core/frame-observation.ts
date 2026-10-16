import { CheckList, defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';
import { observeNextFrame } from './support/observe';

export default defineFeature({
  title: 'Frame observation',
  catalog: 'Frame observation',
  kind: 'probe',
  summary:
    "renderer.requestObservation(['linear-hdr']) arms the next submitted frame; after receipt.completed, renderer.observe(receipt, { include }) returns bounded bytes plus metadata copied inside the same graph.",
  expect:
    'All checks pass: one linear-hdr observation for the exact receipt frame, rgba16float bytes sized bytesPerRow x height, non-black content, and matching graph generation.',
  async setup({ app, world, frames }) {
    spawnStage(world);
    spawnMesh(
      world,
      MESH.sphere,
      standard(world, { baseColor: [1, 0.2, 0.1, 1], emissive: [2, 0.4, 0.2] }),
      {
        pos: [0, 0.6, 0],
      },
    );
    await frames(3);
    return {
      async checks() {
        const checks = new CheckList();
        const outcome = await observeNextFrame(app, ['linear-hdr']);
        checks.ok('observation resolved', outcome.ok, outcome.ok ? undefined : outcome.error);
        if (!outcome.ok) return checks.items;
        const observations = outcome.value.observations ?? [];
        const hdr = observations[0];
        checks
          .equal(
            'exactly one domain returned',
            observations.map((entry) => entry.domain),
            ['linear-hdr'],
          )
          .equal('bound to the receipt frame', outcome.value.frameId, outcome.receiptFrame);
        if (hdr === undefined) return checks.items;
        const { metadata } = hdr;
        checks
          .equal('linear HDR format', metadata.format, 'rgba16float')
          .equal('metadata frame id', metadata.frameId, outcome.receiptFrame)
          .ok(
            'bounded byte size',
            hdr.bytes.byteLength === metadata.bytesPerRow * metadata.height,
            `${hdr.bytes.byteLength} bytes, ${metadata.width}x${metadata.height}`,
          )
          .ok(
            'content is not all zero',
            hdr.bytes.some((byte) => byte !== 0),
          )
          .ok(
            'graph generation recorded',
            metadata.graphGeneration >= 0,
            `graphGeneration=${metadata.graphGeneration}`,
          );
        return checks.items;
      },
    };
  },
});
