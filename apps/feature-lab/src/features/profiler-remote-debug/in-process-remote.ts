import { RemoteError } from '@forgeax/engine/remote';
import { executeScript } from '@forgeax/engine/remote/execute';
import { defineFeature } from '../../lab/feature';
import { spawnStage } from '../../lab/stage';
import { evalInApp } from './_shared/eval';

export default defineFeature({
  title: 'In-process Remote',
  catalog: 'In-process Remote',
  kind: 'probe',
  summary:
    'executeScript evaluates inside the Host realm with no transport, sharing the WebSocket execution core.',
  expect:
    'Expression, statement, and await scripts return values; syntax, runtime, and rethrown RemoteError map to closed codes.',
  async setup({ app, world }) {
    const { camera } = spawnStage(world);
    const expression = await evalInApp(app, '6 * 7');
    const statement = await evalInApp(
      app,
      `const n = world.componentsOf(${Number(camera)}); return n.ok ? n.value.length : -1;`,
    );
    const awaited = await evalInApp(app, 'await Promise.resolve("awaited")');
    const syntax = await evalInApp(app, 'return (;');
    const runtime = await evalInApp(app, 'missingSymbol.call()');
    const rethrow = await executeScript('throw marker', {
      world,
      renderer: app.renderer,
      assets: app.assets,
      importModule: async () => undefined,
    }).catch(() => undefined);
    const custom = await executeScript('throw (await _import("error"))', {
      world,
      renderer: app.renderer,
      assets: app.assets,
      importModule: async () =>
        new RemoteError({
          code: 'eval-result-not-serializable',
          expected: 'feature-lab marker',
          hint: 'marker',
        }),
    });
    const code = (result: Awaited<ReturnType<typeof executeScript>> | undefined): string =>
      result === undefined ? 'rejected' : result.ok ? 'ok' : result.error.code;
    return {
      checks: () => [
        { name: 'lone expression auto-returns 42', ok: expression.ok && expression.value === 42 },
        {
          name: 'statement script reads live World',
          ok: statement.ok && typeof statement.value === 'number' && statement.value >= 2,
          detail: JSON.stringify(statement.ok ? statement.value : statement.error.code),
        },
        { name: 'top-level await is legal', ok: awaited.ok && awaited.value === 'awaited' },
        {
          name: 'syntax error -> script-syntax-error',
          ok: code(syntax) === 'script-syntax-error',
          detail: code(syntax),
        },
        {
          name: 'runtime throw -> script-runtime-error',
          ok: code(runtime) === 'script-runtime-error',
          detail: code(runtime),
        },
        {
          name: 'unknown symbol never rejects the promise',
          ok: rethrow !== undefined && code(rethrow) === 'script-runtime-error',
        },
        {
          name: 'RemoteError thrown by script surfaces verbatim',
          ok: code(custom) === 'eval-result-not-serializable',
          detail: code(custom),
        },
      ],
    };
  },
});
