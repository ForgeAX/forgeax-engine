import { assetLoaderPlugin, assetsPlugin, LoaderRegistry } from '@forgeax/engine/assets-runtime';
import { Context } from '@forgeax/engine/plugin';
import type { Loader } from '@forgeax/engine/types';
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
  title: 'LoaderRegistry',
  catalog: 'LoaderRegistry',
  kind: 'headless',
  summary:
    'Asset kind -> loader mappings are registered through disposers or plugin Fibers (assetLoaderPlugin). One kind has exactly one live owner; revoking the lease frees the kind.',
  expect:
    'register returns a disposer, a duplicate kind is refused, disposing frees the kind for a new owner, and disposing the plugin Fiber removes the loader it contributed.',
  async run(checks) {
    const loaders = new LoaderRegistry();
    const first: Loader<unknown> = { kind: 'lab-dialogue', load: () => ({ lines: ['first'] }) };
    const second: Loader<unknown> = { kind: 'lab-dialogue', load: () => ({ lines: ['second'] }) };
    const dispose = loaders.register(first);
    checks.ok('register returns a disposer', typeof dispose === 'function');
    checks.ok('get(kind) returns the owner', loaders.get('lab-dialogue') === first);
    checks.ok('kind is listed', loaders.registeredKinds().includes('lab-dialogue'));
    checks.ok(
      'duplicate kind is refused',
      throwsTypeError(() => loaders.register(second)),
    );
    checks.ok('first owner survives the refusal', loaders.get('lab-dialogue') === first);
    checks.ok(
      'empty kind is refused',
      throwsTypeError(() => loaders.register({ kind: '', load: () => ({}) })),
    );
    dispose();
    checks.ok('dispose frees the kind', loaders.get('lab-dialogue') === undefined);
    const disposeSecond = loaders.register(second);
    checks.ok('a new owner can claim the kind', loaders.get('lab-dialogue') === second);
    disposeSecond();

    const context = new Context();
    await context.plugin(assetsPlugin({ loaders } as never));
    const cutscene: Loader<unknown> = { kind: 'lab-cutscene', load: () => ({ shots: [] }) };
    const fiber = await context.plugin(assetLoaderPlugin(cutscene));
    checks.ok('plugin Fiber registers the loader', loaders.get('lab-cutscene') === cutscene);
    await fiber.dispose();
    checks.ok('disposing the Fiber revokes the loader', loaders.get('lab-cutscene') === undefined);
  },
});
