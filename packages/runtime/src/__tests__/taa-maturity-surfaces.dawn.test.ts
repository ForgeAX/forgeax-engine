import { it } from 'vitest';
import { ALPHA_HASH_SIZE, verifyAlphaHash } from './alpha-hash.fixture';
import { createBarrelRendererFixture } from './barrel-distortion-gpu-fixture';
import { json, save } from './taa-maturity.fixture';

it
  .skipIf(process.env.TAA_MATURITY !== 'surfaces')
  .each(
    [0.5, 0.67, 0.75].flatMap((scale) =>
      (['standard', 'skin'] as const).map((kind) => ({ scale, kind })),
    ),
  )(
  'retains alpha-hash coverage and rejects faded geometry ($kind, $scale)',
  { timeout: 120_000, retry: 0 },
  async ({ scale, kind }) => {
    const fixture = await createBarrelRendererFixture({
      width: ALPHA_HASH_SIZE,
      height: ALPHA_HASH_SIZE,
    });
    try {
      const evidence = await verifyAlphaHash(fixture.renderer, {
        kind,
        taaScale: scale,
        image(name, bytes, metadata) {
          const label = `surface-${kind}-${scale}-${name}`;
          save(`${label}.raw`, bytes);
          json(`${label}.json`, metadata);
        },
      });
      json(`surface-${kind}-${scale}.json`, evidence);
    } finally {
      fixture.renderer.dispose();
      fixture.renderTarget.destroy();
    }
  },
);
