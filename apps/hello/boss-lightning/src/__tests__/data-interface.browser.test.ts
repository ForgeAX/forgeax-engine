import { describe, expect, it } from 'vitest';
import {
  createCameraProvider,
  createSceneDepthProvider,
  createVfxRuntimeHost,
} from '@forgeax/engine-vfx-render';

const requirements = [
  {
    token: 'vfx:camera' as const,
    kind: 'camera' as const,
    binding: 8,
    bindingType: 'uniform' as const,
    lifetime: 'generation' as const,
  },
  {
    token: 'vfx:scene-depth' as const,
    kind: 'scene-depth' as const,
    binding: 9,
    bindingType: 'sampled-depth' as const,
    lifetime: 'generation' as const,
  },
];

describe('Boss Lightning Data Interface Browser path', () => {
  it('resolves camera and scene depth through the reflected provider protocol', () => {
    const host = createVfxRuntimeHost({
      camera: { read: () => undefined },
      providers: [
        createCameraProvider({
          available: () => true,
          resource: () => ({ kind: 'buffer', value: {}, size: 16, usage: 'uniform' }),
        }),
        createSceneDepthProvider({
          available: () => true,
          sampleCount: 1,
          resource: () => ({ kind: 'texture-view', value: {} }),
        }),
      ],
    });
    const result = host.resolveDataInterfaces({ requirements, generation: 4 });
    expect(result).toMatchObject({ ok: true, value: { readiness: 'ready', generation: 4 } });
  });

  it('does not hide missing depth behind a transparent fallback', () => {
    const host = createVfxRuntimeHost({
      camera: { read: () => undefined },
      providers: [
        createCameraProvider({
          available: () => true,
          resource: () => ({ kind: 'buffer', value: {}, size: 16, usage: 'uniform' }),
        }),
        createSceneDepthProvider({ available: () => false }),
      ],
    });
    const result = host.resolveDataInterfaces({ requirements, generation: 4 });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'vfx-data-interface-missing', detail: { token: 'vfx:scene-depth' } },
    });
  });
});
