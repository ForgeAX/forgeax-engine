import type { ColorTargetDescriptor } from '@forgeax/engine-render-graph';
import type { TextureFormat } from '@forgeax/engine-rhi';
import { describe, expectTypeOf, it } from 'vitest';
import type { StandardProfile } from '../pipeline/standard-profile';

describe('M4 Standard descriptor contract', () => {
  it('keeps graph attachment formats on the RHI TextureFormat union', () => {
    expectTypeOf<ColorTargetDescriptor['format']>().toEqualTypeOf<TextureFormat>();
    const invalid: ColorTargetDescriptor = {
      // @ts-expect-error -- malformed formats never enter a graph declaration.
      format: 'not-a-texture-format',
      size: { w: 1, h: 1 },
    };
    void invalid;
  });

  it('keeps the profile inspectable and free of implementation handles', () => {
    expectTypeOf<StandardProfile['pipelineId']>().toEqualTypeOf<'forgeax::standard'>();
    // @ts-expect-error -- a profile is POD; raw device handles are not a profile field.
    type _NoDevice = StandardProfile['device'];
  });
});
