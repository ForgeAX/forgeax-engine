import { describe, expect, it } from 'vitest';
import { createHostStartup } from '../startup.js';

describe('generic host startup', () => {
  it('owns only supplied Cordis startup entries and releases them', async () => {
    let disposed = false;
    const startup = await createHostStartup({
      startupPlugins: [
        {
          name: 'fixture-startup',
          apply(ctx) {
            ctx.effect(
              () => () => {
                disposed = true;
              },
              'fixture-startup',
            );
          },
        },
      ],
    });

    expect(startup.ownedContext).toBe(true);
    await startup.dispose();
    expect(disposed).toBe(true);
  });
});
