import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { prepareCardIdentityFixture } from './card-primitive-identity.fixture';

it('prepares the actual high Mesh primitive and versioned authored variants without a GPU', async () => {
  const fixture = await prepareCardIdentityFixture();
  expect(fixture.high.instance.indices.length / 3).toBe(65537);
  expect(fixture.high.sections.map((section) => [section.indexOffset, section.indexCount])).toEqual(
    [
      [0, 98304],
      [98304, 98307],
    ],
  );
  expect(fixture.cooked.program.contract).toContain('forgeax-material-card-v4');
  expect(fixture.truncated.program.wgsl).not.toBe(fixture.cooked.program.wgsl);
  expect(fixture.masked.program.contract).toContain('forgeax-material-card-v4');
  expect(fixture.unsupported.program.contract).toContain('forgeax-material-card-v4');
  const masked = await fixture.source(
    [-1, -1, 0, 1, -1, 0, -1, 1, 0],
    new Uint32Array([0, 1, 2]),
    [[0, 3]],
    0,
    fixture.masked,
  );
  expect(masked.sections[0]?.material.snapshot.paramSnapshot).toMatchObject({
    baseColor: [0, 1, 0, 0],
    alphaCutoff: 0.5,
  });
  const output = process.env.FORGEAX_CARD_IDENTITY_PREPARE;
  if (output)
    await writeFile(
      output,
      JSON.stringify(
        {
          highPrimitive: 65536,
          cardCounts: {
            high: fixture.high.layout.cards.length,
            tie: fixture.tie.layout.cards.length,
            occluded: fixture.occluded.layout.cards.length,
          },
          programs: Object.fromEntries(
            (['cooked', 'truncated', 'masked', 'unsupported'] as const).map((name) => {
              const material = fixture[name];
              return [
                name,
                {
                  sha256: createHash('sha256').update(material.program.wgsl).digest('hex'),
                  contract: material.program.contract,
                  sourceClosure: material.program.sourceClosureDigest,
                },
              ];
            }),
          ),
        },
        null,
        2,
      ),
    );
}, 30000);
