import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  ParticleChannelOverflowPolicy,
  ParticleChannelSource,
  ParticleRendererOverflowPolicy,
} from '../code-source.js';
import type { ParticleRendererSourceV3 } from '../code-source-v3.js';
import type {
  ParticleChannelOverflowPolicy as PublicParticleChannelOverflowPolicy,
  ParticleRendererOverflowPolicy as PublicParticleRendererOverflowPolicy,
} from '../index.js';

type BillboardRenderer = Extract<ParticleRendererSourceV3, { readonly kind: 'billboard' }>;
type RendererOverflow = BillboardRenderer['overflow'];
type ChannelOverflow = ParticleChannelSource['overflow'];
type RendererOverflowSlot = Pick<BillboardRenderer, 'overflow'>;
type ChannelOverflowSlot = Pick<ParticleChannelSource, 'overflow'>;

const codeSource = readFileSync(new URL('../code-source.ts', import.meta.url), 'utf8');

describe('VFX channel overflow policy owner', () => {
  it('derives the channel policy from the renderer policy without changing field presence', () => {
    expectTypeOf<ParticleChannelOverflowPolicy>().toEqualTypeOf<ParticleRendererOverflowPolicy>();
    expectTypeOf<ParticleRendererOverflowPolicy>().toEqualTypeOf<ParticleChannelOverflowPolicy>();
    expectTypeOf<PublicParticleChannelOverflowPolicy>().toEqualTypeOf<ParticleChannelOverflowPolicy>();
    expectTypeOf<PublicParticleRendererOverflowPolicy>().toEqualTypeOf<ParticleRendererOverflowPolicy>();
    expectTypeOf<RendererOverflow>().toEqualTypeOf<ParticleRendererOverflowPolicy | undefined>();
    expectTypeOf<ParticleRendererOverflowPolicy | undefined>().toEqualTypeOf<RendererOverflow>();
    expectTypeOf<ChannelOverflow>().toEqualTypeOf<ParticleChannelOverflowPolicy>();
    expectTypeOf<ParticleChannelOverflowPolicy>().toEqualTypeOf<ChannelOverflow>();
    expectTypeOf<RendererOverflowSlot>().toEqualTypeOf<{
      readonly overflow?: ParticleRendererOverflowPolicy;
    }>();
    expectTypeOf<ChannelOverflowSlot>().toEqualTypeOf<{
      readonly overflow: ParticleChannelOverflowPolicy;
    }>();
  });

  it('keeps exactly the drop-newest and drop-oldest members', () => {
    expectTypeOf<ParticleChannelOverflowPolicy>().toEqualTypeOf<'drop-newest' | 'drop-oldest'>();
    expectTypeOf<'drop-newest'>().toExtend<ParticleChannelOverflowPolicy>();
    expectTypeOf<'drop-oldest'>().toExtend<ParticleChannelOverflowPolicy>();
    expectTypeOf<'drop-other'>().not.toExtend<ParticleChannelOverflowPolicy>();
  });

  it('keeps the authored renderer policy as the only production owner', () => {
    expect(codeSource).toContain(
      'export type ParticleChannelOverflowPolicy = ParticleRendererOverflowPolicy;',
    );
    expect(codeSource).not.toContain(
      "export type ParticleChannelOverflowPolicy = 'drop-newest' | 'drop-oldest';",
    );
  });
});
