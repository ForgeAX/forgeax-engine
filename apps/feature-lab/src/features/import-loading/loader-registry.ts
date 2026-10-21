import {
  AssetRegistry,
  assetDecoderPlugin,
  assetsPlugin,
  defineAssetKind,
} from '@forgeax/engine/assets-runtime';
import { Context } from '@forgeax/engine/plugin';
import { ok } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';

function throwsTypeError(body: () => unknown): boolean {
  try {
    body();
    return false;
  } catch (error) {
    return error instanceof TypeError;
  }
}

export default defineFeature({
  title: 'Asset decoder ownership',
  catalog: 'Asset decoder ownership',
  kind: 'headless',
  summary:
    'Each asset kind has one decoder owner. The same owner can hold multiple leases; Cordis Fibers retire their own contributions.',
  expect:
    'A competing owner is rejected until every prior lease is released. Fiber disposal releases its decoder lease.',
  async run(checks) {
    const assets = new AssetRegistry();
    const kind = defineAssetKind<{ lines: string[] }>('lab-dialogue');
    const first = { decode: async () => ok({ lines: ['first'] }) };
    const second = { decode: async () => ok({ lines: ['second'] }) };
    const a = assets.installDecoder(kind, first);
    const b = assets.installDecoder(kind, first);
    checks.ok(
      'competing decoder is refused',
      throwsTypeError(() => assets.installDecoder(kind, second)),
    );
    a.dispose();
    a.dispose();
    checks.ok(
      'the second lease still retains its owner',
      throwsTypeError(() => assets.installDecoder(kind, second)),
    );
    b.dispose();
    const replacement = assets.installDecoder(kind, second);
    checks.ok('a new owner acquires the released kind', typeof replacement.dispose === 'function');
    replacement.dispose();
    const context = new Context();
    const service = await context.plugin(assetsPlugin(assets));
    const fiber = await context.plugin(
      assetDecoderPlugin({ kind, decoder: first, consumer: 'Dialogue' }),
    );
    checks.ok(
      'the Fiber owns the decoder',
      throwsTypeError(() => assets.installDecoder(kind, second)),
    );
    await fiber.dispose();
    const after = assets.installDecoder(kind, second);
    checks.ok('Fiber disposal releases the kind', typeof after.dispose === 'function');
    after.dispose();
    await service.dispose();
    assets.dispose();
  },
});
