import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine-app/browser';

const canvas = document.querySelector<HTMLCanvasElement>('#app') as HTMLCanvasElement;
const created = await createApp(
  canvas,
  {
    ...(import.meta.env.DEV && runtimeBinding ? { assetRuntimeBinding: runtimeBinding } : {}),
    execution: {
      workers: { engine: true, render: false, kernels: false },
      bootstrap: new URL(
        import.meta.env.DEV ? '/src/worker-bootstrap.ts' : '/assets/path-bootstrap.js',
        location.href,
      ),
      diagnostics: { rhiCapture: true },
      startupTimeoutMs: 90000,
      frameTimeoutMs: 30000,
    },
  },
  forgeaxBundlerAdapter(),
);
if (!created.ok) {
  throw new Error(
    JSON.stringify(
      {
        ...('code' in created.error ? { code: created.error.code } : {}),
        ...('expected' in created.error ? { expected: created.error.expected } : {}),
        ...('hint' in created.error ? { hint: created.error.hint } : {}),
        detail: created.error.detail,
      },
      (_key, value) =>
        value instanceof Error
          ? Object.fromEntries(
              Object.getOwnPropertyNames(value).map((key) => [key, Reflect.get(value, key)]),
            )
          : value,
    ),
  );
}
const app = created.value;
if (!app.remoteEval) throw new Error('Worker inspection absent');
const inspect = app.remoteEval.bind(app);
Object.assign(globalThis, {
  __pathWorker: {
    app,
    report: () => app.execution.report(),
    snapshot: () => inspect("return world.getResource('PathSnapshot')();"),
    async step(frames: number) {
      app.resume().unwrap();
      await inspect(
        "const f=world.components.resolve('PathFollower');for(const row of world.query({write:[f]}).unwrap())row.mut(f).paused=false;",
      );
      const first = (await inspect("return world.getResource('PathSnapshot')();")) as {
        tick: number;
      };
      while (
        ((await inspect("return world.getResource('PathSnapshot')();")) as { tick: number }).tick <
        first.tick + frames
      )
        await new Promise((resolve) => setTimeout(resolve, 5));
      const snapshot = await inspect(
        "const f=world.components.resolve('PathFollower');for(const row of world.query({write:[f]}).unwrap())row.mut(f).paused=true;return world.getResource('PathSnapshot')();",
      );
      app.pause().unwrap();
      return snapshot;
    },
    async capture() {
      // The native Worker recorder needs an ordinary admitted App frame.
      // Freeze follower progress through its public component while the Host
      // supplies that frame; simulation time remains owned by the World.
      app.resume().unwrap();
      try {
        return await inspect(
          "const before=world.getResource('PathSnapshot')();const r=await rhiCapture.captureFrame();return r.ok?{ok:true,value:{bytes:r.value.bytes,digest:r.value.digest},snapshot:world.getResource('PathSnapshot')(),tickRange:[before.tick,world.getResource('PathSnapshot')().tick]}:{ok:false,error:r.error};",
        );
      } finally {
        app.pause().unwrap();
      }
    },
  },
});
app.start().unwrap();
