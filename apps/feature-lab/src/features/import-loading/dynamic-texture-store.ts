import { type DynamicTextureDevice, DynamicTextureStore } from '@forgeax/engine/assets-runtime';
import { ok, type Texture, type TextureView } from '@forgeax/engine/rhi';
import { defineFeature } from '../../lab/feature';

interface Counters {
  created: number;
  destroyed: number;
  copies: number;
}

function stubDevice(counters: Counters): DynamicTextureDevice {
  let serial = 0;
  return {
    createTexture: () => {
      counters.created++;
      return ok({ serial: serial++ } as unknown as Texture);
    },
    createTextureView: (texture: Texture) => ok({ of: texture } as unknown as TextureView),
    destroyTexture: () => {
      counters.destroyed++;
      return ok(undefined);
    },
    queue: {
      copyExternalImageToTexture: () => {
        counters.copies++;
        return ok(undefined);
      },
    },
  };
}

const SOURCE = {} as Parameters<DynamicTextureStore['uploadFrame']>[1];

export default defineFeature({
  title: 'DynamicTextureStore',
  catalog: 'DynamicTextureStore',
  kind: 'headless',
  summary:
    'Per-frame external image sources (video, canvas) upload into one transient texture per key. A counting device stub exposes allocation, copy, and destruction without a GPU.',
  expect:
    'No upload before a device exists; a steady size allocates once and skips unchanged versions; a resize or a device replacement reallocates; aborting the lifetime signal and destroyAll release every texture.',
  run(checks) {
    const store = new DynamicTextureStore();
    const key = {};
    checks.ok('no device -> no upload', store.uploadFrame(key, SOURCE, 16, 16) === undefined);
    const counters: Counters = { created: 0, destroyed: 0, copies: 0 };
    store.configureGpuDevice(stubDevice(counters));
    checks.ok(
      'non-positive size -> no upload',
      store.uploadFrame(key, SOURCE, 0, 16) === undefined,
    );

    const lifetime = new AbortController();
    const upload = (size: number, version: number) =>
      store.uploadFrame(key, SOURCE, size, size, { version, signal: lifetime.signal });
    const first = upload(32, 1);
    const same = upload(32, 1);
    checks.ok('first upload ok', first?.ok === true);
    checks.ok(
      'same view reused',
      first?.ok === true && same?.ok === true && first.value === same.value,
    );
    checks.equal('allocate once, copy once for an unchanged version', counters, {
      created: 1,
      destroyed: 0,
      copies: 1,
    });
    upload(32, 2);
    checks.equal('new version copies in place', counters, { created: 1, destroyed: 0, copies: 2 });
    upload(64, 3);
    checks.equal('resize reallocates', counters, { created: 2, destroyed: 1, copies: 3 });

    store.configureGpuDevice(stubDevice(counters));
    checks.ok('device replacement re-uploads', upload(64, 3)?.ok === true);
    checks.equal('replacement recreated the texture', counters, {
      created: 3,
      destroyed: 2,
      copies: 4,
    });

    lifetime.abort();
    checks.ok('abort releases the view', store.getView(key) === undefined);
    checks.ok('aborted lifetime refuses uploads', upload(64, 4) === undefined);
    checks.equal('abort destroyed the texture', counters.destroyed, 3);

    const other = {};
    store.uploadFrame(other, SOURCE, 8, 8);
    store.destroyAll();
    checks.ok('destroyAll clears views', store.getView(other) === undefined);
    checks.equal('destroyAll destroys the rest', counters.destroyed, 4);
  },
});
