// feat-20260623-world-space-video-asset M4 / w15 — DynamicTextureStore unit.
//
// D-3 / AC-08: the transient video texture path is fully independent of
// GpuResidencyCache.ensureResident (the static "upload once / cache forever"
// cache). This test pins the three load-bearing properties:
//   1. isolation — the module does NOT import GpuResidencyCache (source scan).
//   2. allocate-once — a steady-size clip creates exactly one GPU texture; each
//      subsequent frame is a copyExternalImageToTexture write, not a new create.
//   3. resize-on-change — a dimension change destroys the old texture and
//      allocates a new one (so a clip whose intrinsic size resolves late still
//      renders correctly).
// Plus the structured-failure contract (charter P3): a device that rejects the
// copy returns a Result.err, never throws.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type DynamicTextureDevice, DynamicTextureStore } from '@forgeax/engine-assets-runtime';
import type { Result, Texture, TextureView } from '@forgeax/engine-rhi';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
import type { Handle } from '@forgeax/engine-types';
import { toShared } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

const STORE_SRC = fileURLToPath(
  new URL('../../../assets-runtime/src/dynamic-texture-store.ts', import.meta.url),
);

interface DeviceProbe {
  created: number;
  destroyed: number;
  copies: number;
}

function makeMockDevice(
  probe: DeviceProbe,
  opts: { copyFails?: boolean } = {},
): DynamicTextureDevice {
  let nextTex = 0;
  return {
    createTexture: (): Result<Texture, RhiError> => {
      probe.created += 1;
      return ok({ __tex: `tex-${++nextTex}` } as unknown as Texture);
    },
    createTextureView: (tex: Texture): Result<TextureView, RhiError> =>
      ok({ __view: tex } as unknown as TextureView),
    destroyTexture: (): Result<void, RhiError> => {
      probe.destroyed += 1;
      return ok(undefined);
    },
    queue: {
      copyExternalImageToTexture: (): Result<void, RhiError> => {
        probe.copies += 1;
        if (opts.copyFails === true) {
          return err(
            new RhiError({
              code: 'webgpu-runtime-error',
              expected: 'copyExternalImageToTexture succeeds',
              hint: 'video source not yet decodable',
            }),
          );
        }
        return ok(undefined);
      },
    },
  };
}

const FAKE_SOURCE = {} as unknown as GPUCopyExternalImageSourceInfo['source'];

function clip(id: number): Handle<'VideoAsset', 'shared'> {
  return toShared<'VideoAsset'>(id);
}

describe('DynamicTextureStore isolation (M4 / w15)', () => {
  it('does NOT import GpuResidencyCache (AC-08 / D-3 independence)', () => {
    const src = readFileSync(STORE_SRC, 'utf8');
    // Scan import statements only — the file's prose comments reference the
    // store/ensureResident to explain WHY they are kept separate (D-3); the
    // load-bearing invariant is the absence of an actual import edge.
    const importLines = src.split('\n').filter((l) => /^\s*import\b/.test(l));
    for (const line of importLines) {
      expect(line.includes('device/gpu-residency'), `unexpected import: ${line}`).toBe(false);
    }
    // No call to the static residency cache method anywhere in executable code
    // (strip comments first so the explanatory prose does not trip the gate).
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(stripped.includes('ensureResident')).toBe(false);
  });
});

describe('DynamicTextureStore lifecycle (M4 / w15)', () => {
  it('allocate-once: a steady-size clip creates one texture, writes every frame', () => {
    const probe: DeviceProbe = { created: 0, destroyed: 0, copies: 0 };
    const store = new DynamicTextureStore();
    store.configureGpuDevice(makeMockDevice(probe));
    const h = clip(701);

    for (let frame = 0; frame < 5; frame++) {
      const res = store.uploadFrame(h, FAKE_SOURCE, 320, 240);
      expect(res?.ok).toBe(true);
    }
    expect(probe.created).toBe(1);
    expect(probe.copies).toBe(5);
    expect(probe.destroyed).toBe(0);
    expect(store.getView(h)).toBeDefined();
  });

  it('resize-on-change: a dimension change destroys the old texture + allocates a new one', () => {
    const probe: DeviceProbe = { created: 0, destroyed: 0, copies: 0 };
    const store = new DynamicTextureStore();
    store.configureGpuDevice(makeMockDevice(probe));
    const h = clip(702);

    expect(store.uploadFrame(h, FAKE_SOURCE, 320, 240)?.ok).toBe(true);
    expect(store.uploadFrame(h, FAKE_SOURCE, 320, 240)?.ok).toBe(true);
    expect(probe.created).toBe(1);

    // Intrinsic size resolved (e.g. metadata loaded) -> new dimensions.
    expect(store.uploadFrame(h, FAKE_SOURCE, 640, 480)?.ok).toBe(true);
    expect(probe.created).toBe(2);
    expect(probe.destroyed).toBe(1);
  });

  it('two clips get independent transient textures', () => {
    const probe: DeviceProbe = { created: 0, destroyed: 0, copies: 0 };
    const store = new DynamicTextureStore();
    store.configureGpuDevice(makeMockDevice(probe));

    expect(store.uploadFrame(clip(710), FAKE_SOURCE, 100, 100)?.ok).toBe(true);
    expect(store.uploadFrame(clip(711), FAKE_SOURCE, 100, 100)?.ok).toBe(true);
    expect(probe.created).toBe(2);
    expect(store.getView(clip(710))).not.toBe(store.getView(clip(711)));
  });

  it('device swap destroys stale entries before reusing a clip', () => {
    const first: DeviceProbe = { created: 0, destroyed: 0, copies: 0 };
    const second: DeviceProbe = { created: 0, destroyed: 0, copies: 0 };
    const store = new DynamicTextureStore();
    const h = clip(740);

    store.configureGpuDevice(makeMockDevice(first));
    expect(store.uploadFrame(h, FAKE_SOURCE, 320, 240)?.ok).toBe(true);

    store.configureGpuDevice(makeMockDevice(second));
    expect(first.destroyed).toBe(1);
    expect(store.getView(h)).toBeUndefined();

    expect(store.uploadFrame(h, FAKE_SOURCE, 320, 240)?.ok).toBe(true);
    expect(second.created).toBe(1);
    expect(second.copies).toBe(1);
  });
});

describe('DynamicTextureStore degrade paths (M4 / w15, charter P3)', () => {
  it('returns undefined (not an error) before a device is wired', () => {
    const store = new DynamicTextureStore();
    expect(store.uploadFrame(clip(720), FAKE_SOURCE, 320, 240)).toBeUndefined();
    expect(store.getView(clip(720))).toBeUndefined();
  });

  it('returns undefined for zero / unknown source dimensions (metadata pending)', () => {
    const probe: DeviceProbe = { created: 0, destroyed: 0, copies: 0 };
    const store = new DynamicTextureStore();
    store.configureGpuDevice(makeMockDevice(probe));
    expect(store.uploadFrame(clip(721), FAKE_SOURCE, 0, 0)).toBeUndefined();
    expect(probe.created).toBe(0);
  });

  it('returns a structured RhiError when the copy fails (never throws)', () => {
    const probe: DeviceProbe = { created: 0, destroyed: 0, copies: 0 };
    const store = new DynamicTextureStore();
    store.configureGpuDevice(makeMockDevice(probe, { copyFails: true }));
    const res = store.uploadFrame(clip(722), FAKE_SOURCE, 320, 240);
    expect(res?.ok).toBe(false);
    if (res !== undefined && !res.ok) {
      expect(res.error.code).toBe('webgpu-runtime-error');
    }
  });

  it('destroyAll destroys every transient texture + clears the views', () => {
    const probe: DeviceProbe = { created: 0, destroyed: 0, copies: 0 };
    const store = new DynamicTextureStore();
    store.configureGpuDevice(makeMockDevice(probe));
    store.uploadFrame(clip(730), FAKE_SOURCE, 64, 64);
    store.uploadFrame(clip(731), FAKE_SOURCE, 64, 64);
    store.destroyAll();
    expect(probe.destroyed).toBe(2);
    expect(store.getView(clip(730))).toBeUndefined();
  });
});
