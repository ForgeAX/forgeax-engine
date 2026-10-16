import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { captureCanvasPixels } from '@forgeax/apps-shared/canvas-capture';
import { createApp } from '@forgeax/engine/app/browser';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) throw new Error('canvas missing');
const status = document.querySelector<HTMLOutputElement>('#status');
async function start(target: HTMLCanvasElement) {
  const source = new MessageChannel(),
    name = `skeletal-motion-${crypto.randomUUID()}`,
    channel = new BroadcastChannel(name);
  source.port1.start();
  const nativeLosses: {
    rendererTimeOrigin: number;
    reason: string;
    message: string;
  }[] = [];
  const receiveNativeLoss = ({ data }: MessageEvent) => {
    if (data?.kind !== 'skeletal-motion-native-loss') return;
    nativeLosses.push({
      rendererTimeOrigin: data.rendererTimeOrigin,
      reason: data.reason,
      message: data.message,
    });
    if (nativeLosses.length > 8) nativeLosses.shift();
  };
  channel.addEventListener('message', receiveNativeLoss);
  const request = (port: MessagePort | BroadcastChannel, command: string): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const receive = (event: Event) => {
        const { data } = event as MessageEvent;
        if (data?.id !== id) return;
        clearTimeout(timer);
        port.removeEventListener('message', receive);
        if (data.ok === false) reject(new Error(data.error));
        else resolve(data.value);
      };
      const timer = setTimeout(() => {
        port.removeEventListener('message', receive);
        reject(new Error(`skeletal motion ${command} deadline exceeded`));
      }, 60000);
      port.addEventListener('message', receive);
      port.postMessage({ id, command });
    });
  const split = new URL(location.href).searchParams.get('split') !== 'false';
  const app = (
    await createApp(
      target,
      {
        animation: { cadence: 'fixed' },
        time: { fixedDeltaSeconds: 1 / 60, maxStepsPerUpdate: 4 },
        ...(runtimeBinding === undefined ? {} : { assetRuntimeBinding: runtimeBinding }),
        execution: {
          workers: { engine: true, render: split, kernels: false },
          bootstrap: new URL(
            import.meta.env.DEV
              ? '/src/skeletal-motion-worker-bootstrap.ts'
              : '/assets/skeletal-motion-bootstrap.js',
            location.href,
          ),
          bootstrapData: { channel: name },
          bootstrapPort: source.port2,
          diagnostics: { rhiCapture: true },
          startupTimeoutMs: 120000,
          frameTimeoutMs: 60000,
        },
      },
      forgeaxBundlerAdapter(),
    )
  ).unwrap();
  const failures: unknown[] = [];
  app.onError((error) => failures.push(error));
  app.start().unwrap();
  const timer = setInterval(() => {
    if (status) status.value = JSON.stringify(app.execution.report().world);
  }, 500);
  window.addEventListener('pagehide', () => {
    clearInterval(timer);
    void app.dispose();
    channel.removeEventListener('message', receiveNativeLoss);
    channel.close();
    source.port1.close();
  });
  Object.assign(globalThis, {
    __skeletalMotionWorker: {
      app,
      failures,
      nativeLosses,
      snapshot: () => request(source.port1, 'snapshot'),
      simulate: () => request(source.port1, 'simulate'),
      rebind: () => request(source.port1, 'rebind'),
      poison: () => request(source.port1, 'poison'),
      renderer: () => request(channel, 'snapshot'),
      recoverDeviceLoss: () => request(channel, 'recover'),
      async capture() {
        if (app.remoteEval === undefined) throw new Error('Worker inspection unavailable');
        const inspect = app.remoteEval.bind(app);
        const phase = (name: string) => console.debug('skeletal-motion-worker-capture', name);
        const drain = async () => {
          const deadline = performance.now() + 60000;
          while (app.execution.report().frame.inFlight !== 0) {
            if (performance.now() > deadline) throw new Error('Worker frame credit did not drain');
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        };
        app.pause().unwrap();
        try {
          phase('drain-initial-frame-credit');
          await drain();
          const pulse = async () => {
            let received: (() => void) | undefined;
            const completed = new Promise<void>((resolve) => {
              received = resolve;
            });
            const pauseOnPulse = (event: MessageEvent) => {
              if (event.data?.kind === 'skeletal-motion-pulse') {
                app.pause().unwrap();
                source.port1.removeEventListener('message', pauseOnPulse);
                received?.();
              }
            };
            source.port1.addEventListener('message', pauseOnPulse);
            phase('request-zero-delta-pulse');
            await request(source.port1, 'pulse');
            phase('resume-for-zero-delta-pulse');
            app.resume().unwrap();
            await Promise.race([
              completed,
              new Promise((_, reject) =>
                setTimeout(
                  () => reject(new Error('zero-delta Worker pulse deadline exceeded')),
                  60000,
                ),
              ),
            ]);
            phase('drain-zero-delta-pulse-credit');
            await drain();
          };
          const before = (await request(source.port1, 'snapshot')) as { tick: number };
          // Inspection admission belongs to the next App frame even while paused.
          phase('queue-capture-admission');
          const armed = inspect(
            "world.insertResource('SkeletalMotionProofCapture', rhiCapture.captureFrame()); return true;",
          );
          await pulse();
          phase('await-capture-admission-result');
          await armed;
          let receiveTape: ((event: MessageEvent) => void) | undefined;
          const transported = new Promise<{ bytes: Uint8Array; digest: string }>((resolve) => {
            receiveTape = (event) => {
              if (event.data?.kind !== 'skeletal-motion-tape') return;
              if (receiveTape !== undefined)
                source.port1.removeEventListener('message', receiveTape);
              resolve(event.data);
            };
            source.port1.addEventListener('message', receiveTape);
          });
          phase('queue-capture-read');
          const read = inspect(
            "const r=await world.getResource('SkeletalMotionProofCapture');world.removeResource('SkeletalMotionProofCapture');if(!r.ok)throw r.error;world.getResource('SkeletalMotionProofPort').postMessage({kind:'skeletal-motion-tape',bytes:r.value.bytes,digest:r.value.digest},[r.value.bytes.buffer]);return {digest:r.value.digest};",
          );
          let tape: { bytes: Uint8Array; digest: string };
          try {
            // Snapshot readback is asynchronous. Continue frozen-time frames until
            // the recorder has both seeded resources and recorded the next frame.
            let readFinished = false;
            const settled = read.then(
              () => {
                readFinished = true;
              },
              () => {
                readFinished = true;
              },
            );
            const deadline = performance.now() + 180000;
            phase('pulse-until-capture-read-completes');
            while (!readFinished) {
              if (performance.now() > deadline) throw new Error('Worker capture deadline exceeded');
              await pulse();
              await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, 10))]);
            }
            phase('await-capture-read');
            await read;
            phase('await-binary-tape-transport');
            tape = await transported;
          } finally {
            if (receiveTape !== undefined) source.port1.removeEventListener('message', receiveTape);
          }
          const after = (await request(source.port1, 'snapshot')) as { tick: number };
          if (before.tick !== after.tick)
            throw new Error(
              'a Worker pulse advanced fixed time; this capture cannot establish a fixed-tick palette',
            );
          const currentCanvas = app.canvas;
          if (currentCanvas === undefined) throw new Error('Worker canvas missing');
          phase('live-canvas-readback');
          const live = await captureCanvasPixels(currentCanvas);
          if (!live.ok) throw live.error;
          return {
            tape,
            snapshot: await request(source.port1, 'snapshot'),
            report: app.execution.report(),
            livePixels: live.value,
          };
        } finally {
          app.resume().unwrap();
        }
      },
    },
  });
}
start(canvas).catch((error) => {
  Object.assign(globalThis, {
    __skeletalMotionWorkerFailure:
      error instanceof Error
        ? {
            name: error.name,
            message: error.message,
            stack: error.stack,
            ...Object.fromEntries(Object.entries(error)),
          }
        : error,
  });
  console.error(JSON.stringify(error));
  if (status) status.value = String(error);
});
