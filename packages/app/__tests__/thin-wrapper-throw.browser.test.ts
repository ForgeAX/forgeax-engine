import { testPlatform } from '../src/__tests__/platform-fixture';
// thin-wrapper-throw.browser.test.ts -- M4 (w8) sub-fixture: createRenderer
// throw path isolated into its own file so vi.mock hoists at module level.
//
// Pinned contract (per plan-strategy D-5 / D-6 + research section 2.2):
//   - createRenderer construction-time throw is wrapped into Result.err
//   - the EngineEnvironmentError instance is forwarded VERBATIM (no
//     re-wrap), so callers retain reference equality + can read
//     .detail.webgpuError?.code via the double-layer narrow pattern
//
// This file is split out from thin-wrapper.browser.test.ts because vi.mock
// hoists to the top of the module and applies to the whole file -- pairing
// the success path (which needs the real createRenderer) with the throw
// path in one file is not viable.

import { World } from '@forgeax/engine-ecs';
import { type Renderer } from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-render/internal/construct-renderer';
import { describe, expect, it, vi } from 'vitest';

const innerWebgpuError = new Error('navigator.gpu missing');
Object.assign(innerWebgpuError, {
  code: 'rhi-not-available',
  expected: 'WebGPU adapter present',
  hint: 'navigator.gpu missing',
  name: 'RhiError',
});
const constructionThrow = new EngineEnvironmentError(
  'no usable rendering backend',
  // biome-ignore lint/suspicious/noExplicitAny: test stand-in for RhiError surface
  { webgpuError: innerWebgpuError as any },
);

vi.mock('@forgeax/engine-runtime/internal/renderer-host', () => {
  return {
    constructRuntimeRendererHost: (): Promise<never> => Promise.reject(constructionThrow),
    loadRhiPack: vi.fn(),
  };
});

describe('createApp(canvas) thin wrapper -- (A) path createRenderer throw (AC-01)', () => {
  it(
    'createRenderer throws EngineEnvironmentError -> Result.err preserves original object + .detail.webgpuError?.code',
    async () => {
      // Use a dynamic import so the vi.mock hoist takes effect before
      // the create-app module graph is loaded.
      const { createApp } = await import('../src/browser');
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      document.body.appendChild(canvas);
      try {
        const result = await createApp(canvas);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        const err = result.error;
        // double-layer narrow: instanceof first, then access
        // .detail.webgpuError?.code. Reference equality on the
        // EngineEnvironmentError instance proves no re-wrap happened.
        expect(err instanceof EngineEnvironmentError).toBe(true);
        if (!(err instanceof EngineEnvironmentError)) return;
        expect(err).toBe(constructionThrow);
        expect((err.detail.webgpuError as { code?: string } | undefined)?.code).toBe(
          'rhi-not-available',
        );
      } finally {
        canvas.remove();
      }
    },
    45_000,
  );

  it('(B) assemble path is unaffected by createRenderer mock (host owns renderer)', async () => {
    // Sanity counter: the (B) path never calls createRenderer, so the
    // mock above is irrelevant; world/renderer reference equality holds.
    const { createApp } = await import('../src/index');
    const renderer = {
      attach() {
        throw new Error('assemble fixture does not start');
      },
      draw() {
        throw new Error('assemble fixture does not start');
      },
      setProfile() {
        return { ok: true as const, value: undefined };
      },
      state: () => 'alive' as const,
      inspect: () => undefined as never,
      observe: async () => undefined as never,
      subscribe(): () => void {
        return () => {
          // no-op
        };
      },
      releaseSurface() {
        return { ok: true as const, value: undefined };
      },
      restoreSurface() {
        return { ok: true as const, value: undefined };
      },
      recover: async () => ({ ok: true as const, value: undefined }),
      dispose: async () => ({ ok: true as const, value: undefined }),
    } as unknown as Renderer;
    const world = new World();
    const result = await createApp({ platform: testPlatform(),  renderer, world });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.renderer).toBe(renderer);
    expect(result.value.world).toBe(world);
  });
});
