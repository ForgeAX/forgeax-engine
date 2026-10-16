import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, FixedUpdate, Update } from '@forgeax/engine-ecs';
import {
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  perspective,
} from '@forgeax/engine-render';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import type { ExecutionBootstrapEntry } from '../src/execution/bootstrap-entry';

/** Test-only access to the real child Worker, used to terminate its GPU owner. */
const entry: ExecutionBootstrapEntry = (data) => {
  let renderWorker: Worker | undefined;
  const NativeWorker = globalThis.Worker;
  let recordPublication: (baseline: boolean) => void = () => {};
  let recordDelivery: (durationMs: number) => void = () => {};
  globalThis.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      if (options?.name === 'forgeax-render') {
        const original = String(url);
        const source = `
          let device;
          let injectedLoss = false;
          let ready = false;
          const pending = [];
          const requestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
          navigator.gpu.requestAdapter = async (...args) => {
            const adapter = await requestAdapter(...args);
            if (adapter) {
              const requestDevice = adapter.requestDevice.bind(adapter);
              adapter.requestDevice = async (...args) => {
                device = await requestDevice(...args);
                const nativeLoss = device.lost;
                // destroy() is the real GPU loss trigger, but its native reason
                // denotes intentional teardown. Only this recovery injection
                // projects it as unexpected loss; normal disposal stays native.
                Object.defineProperty(device, 'lost', { value: nativeLoss.then(info =>
                  injectedLoss && info.reason === 'destroyed'
                    ? { reason: 'unknown', message: 'Render Worker fixture loss: ' + info.message }
                    : info
                ) });
                return device;
              };
            }
            return adapter;
          };
          addEventListener('message', event => {
            if (!ready) { pending.push(event.data); event.stopImmediatePropagation(); return; }
            if (event.data === 'lose-device') { event.stopImmediatePropagation(); injectedLoss = true; device.destroy(); }
            if (event.data.kind === 'draw' && event.data.__sentAt !== undefined) {
              postMessage({kind: 'probe-delivery', durationMs: performance.timeOrigin + performance.now() - event.data.__sentAt});
            }
          });
          await import(${JSON.stringify(original)});
          ready = true;
          for (const data of pending) dispatchEvent(new MessageEvent('message', {data}));
        `;
        url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      }
      super(url, options);
      if (options?.name === 'forgeax-render') {
        renderWorker = this;
        this.addEventListener('message', (event) => {
          if (event.data.kind === 'probe-delivery') {
            event.stopImmediatePropagation();
            recordDelivery(event.data.durationMs);
          }
        });
        const post = this.postMessage.bind(this);
        this.postMessage = (message, options?: Transferable[] | StructuredSerializeOptions) => {
          const forwarded =
            message.kind === 'draw'
              ? { ...message, __sentAt: performance.timeOrigin + performance.now() }
              : message;
          if (Array.isArray(options)) post(forwarded, options);
          else post(forwarded, options);
          if (message.kind === 'draw') recordPublication(message.publication.baseline);
        };
      }
    }
  };
  return {
    plugins: [
      {
        name: 'publication-browser-fixture',
        inject: ['world', 'executionBootstrapHost'],
        apply(ctx) {
          const count = typeof data === 'number' ? data : 100;
          ctx.world
            .spawn(
              { component: Transform, data: { pos: [0, 0, 8] } },
              {
                component: Camera,
                data: perspective({ fov: Math.PI / 3, aspect: 1, near: 0.1, far: 2000 }),
              },
            )
            .unwrap();
          ctx.world
            .spawn(
              { component: Transform, data: {} },
              {
                component: DirectionalLight,
                data: { intensity: 3, direction: [-0.5, -1, -0.3], color: [1, 1, 1] },
              },
            )
            .unwrap();
          const movers: EntityHandle[] = [];
          for (let i = 0; i < count; i++) {
            const entity = ctx.world
              .spawn(
                {
                  component: Transform,
                  data: {
                    pos: [
                      ((i % 10) - 5) * 0.3,
                      ((Math.floor(i / 10) % 10) - 5) * 0.3,
                      -Math.floor(i / 100) * 2,
                    ],
                    scale: [0.2, 0.2, 0.2],
                  },
                },
                { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
                { component: MeshRenderer, data: {} },
              )
              .unwrap();
            if (i < 500) movers.push(entity);
          }
          const timings = {
            deliveryMs: [] as number[],
            updateMs: [] as number[],
            publicationMs: [] as number[],
            drawSubmitMs: [] as number[],
            gameplayMs: [] as number[],
            propagationMs: [] as number[],
          };
          recordDelivery = (durationMs) => {
            if (timings.deliveryMs.length < 4096) timings.deliveryMs.push(durationMs);
          };
          for (const [token, name] of [
            [Update, 'propagateTransforms'],
            [FixedUpdate, 'propagateTransformsFixed'],
          ] as const) {
            ctx.world
              .replaceSystem(token, name, {
                name,
                queries: [],
                fn: (world) => {
                  const started = performance.now();
                  try {
                    propagateTransforms(world).unwrap();
                  } finally {
                    if (timings.propagationMs.length < 4096)
                      timings.propagationMs.push(performance.now() - started);
                  }
                },
              })
              .unwrap();
          }
          const originalUpdate = ctx.world.update.bind(ctx.world);
          let updateFinished = 0;
          ctx.world.update = (delta) => {
            const start = performance.now();
            try {
              return originalUpdate(delta);
            } finally {
              updateFinished = performance.now();
              if (timings.updateMs.length < 4096) timings.updateMs.push(updateFinished - start);
            }
          };
          const publications: { baseline: boolean; durationMs: number }[] = [];
          let publicationSent = false;
          const port = ctx.executionBootstrapHost.port;
          let ticks = 0;
          const scope = globalThis as unknown as {
            postMessage(message: { kind: string; epoch?: number }, transfer?: Transferable[]): void;
          };
          const originalPost = scope.postMessage.bind(scope);
          scope.postMessage = (message, transfer) => {
            if (
              (message.kind === 'render-lost' || message.kind === 'render-ready') &&
              (message.epoch ?? 0) > 1
            )
              port?.postMessage({
                kind: 'render-lifecycle',
                phase: message.kind,
                epoch: message.epoch,
                ticks,
                worldIdentity: ctx.world.identity,
              });
            const rows =
              message.kind === 'simulation-complete'
                ? timings.publicationMs
                : message.kind === 'frame-submitted'
                  ? timings.drawSubmitMs
                  : undefined;
            if (rows !== undefined && rows.length < 4096)
              rows.push(performance.now() - updateFinished);
            if (message.kind === 'simulation-complete' && publicationSent) {
              const row = publications.at(-1);
              if (row !== undefined) row.durationMs = performance.now() - updateFinished;
              publicationSent = false;
            }
            originalPost(message, transfer);
          };
          recordPublication = (baseline) => {
            publicationSent = true;
            if (publications.length < 4096)
              publications.push({ baseline, durationMs: performance.now() - updateFinished });
          };
          const system = {
            name: 'publication-tick-proof',
            queries: [],
            fn: (world: typeof ctx.world) => {
              const started = performance.now();
              ticks++;
              for (let i = 0; i < movers.length; i++) {
                const entity = movers[i];
                if (entity !== undefined)
                  world
                    .set(entity, Transform, {
                      pos: [
                        ((i % 10) - 5) * 0.3 + Math.sin(ticks / 30) * 0.1,
                        ((Math.floor(i / 10) % 10) - 5) * 0.3,
                        -Math.floor(i / 100) * 2,
                      ],
                    })
                    .unwrap();
              }
              if (timings.gameplayMs.length < 4096)
                timings.gameplayMs.push(performance.now() - started);
            },
          };
          ctx.world.addSystem(Update, system).unwrap();
          if (port !== undefined) {
            port.onmessage = (event) => {
              if (event.data === 'reset-metrics') {
                for (const rows of Object.values(timings)) rows.length = 0;
                publications.length = 0;
              }
              if (event.data === 'metrics') {
                port.postMessage({ ...timings, publications });
                return;
              }
              if (event.data === 'terminate-render') renderWorker?.terminate();
              if (event.data === 'lose-device') renderWorker?.postMessage('lose-device');
              port.postMessage({ ticks, worldIdentity: ctx.world.identity, command: event.data });
            };
            port.start();
          }
          return () => {
            ctx.world.removeSystem(Update, system.name).unwrap();
            globalThis.Worker = NativeWorker;
            ctx.world.update = originalUpdate;
            scope.postMessage = originalPost;
          };
        },
      },
    ],
  };
};
export default entry;
