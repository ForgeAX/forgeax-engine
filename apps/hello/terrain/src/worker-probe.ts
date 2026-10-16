/// <reference types="vite/client" />
import { AssetGuid } from '@forgeax/engine-pack/source';
import { terrainGuid } from './identity.ts';
import { runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine-app/browser';
import { ANTIALIAS_TAA } from '@forgeax/engine-render';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

// TapeArtifact includes a streaming function; only its POD projection crosses
// the existing Worker inspection transport.
const captureScript =
  'const r=await rhiCapture.captureFrame(); return r.ok ? {ok:true,value:{kind:r.value.kind,digest:r.value.digest,bytes:r.value.bytes}} : {ok:false,error:r.error};';

interface ProofTemporal {
  viewIdentity: string;
  frameIndex: number;
  mode: string;
  resetReason?: string;
  historyAttempt: string;
}
interface EngineProof {
  completedFrames: number;
  temporal: ProofTemporal;
  failures: {
    code: string;
    before: ProofTemporal;
    after: ProofTemporal;
    query?: { ok: boolean };
  }[];
  recoveries: { temporal: ProofTemporal; query?: { ok: boolean } }[];
}

function response<T>(
  target: MessagePort | BroadcastChannel,
  predicate: (data: unknown) => data is T,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const receive = (input: Event) => {
      const event = input as MessageEvent;
      if (!predicate(event.data)) return;
      clearTimeout(timer);
      target.removeEventListener('message', receive);
      resolve(event.data);
    };
    const timer = setTimeout(() => {
      target.removeEventListener('message', receive);
      reject(new Error('terrain Worker response timed out'));
    }, 60000);
    target.addEventListener('message', receive);
  });
}
export async function startTerrainWorkerProbe(
  canvas: HTMLCanvasElement,
  engineOnly = false,
  rootGuid = terrainGuid,
): Promise<void> {
  let capture = async (): Promise<unknown> => {
    throw new Error('terrain Worker is not ready');
  };
  Object.assign(globalThis, {
    __forgeax: {
      captureFrame: async () => {
        try {
          return await capture();
        } catch (error) {
          const failure =
            error instanceof Error
              ? { name: error.name, message: error.message }
              : error;
          Object.assign(globalThis, { __forgeaxBootstrapFailure: failure });
          throw new Error(`terrain Worker recorder failed: ${JSON.stringify(failure)}`, {
            cause: error,
          });
        }
      },
    },
  });
  const source = new MessageChannel();
  source.port1.start();
  const ready = response<{
    subjects: { terrain: number; walker: number };
    asset: number;
    rootGuid: string;
    materialEncoding: unknown;
  }>(
    source.port1,
    (
      data,
    ): data is {
      subjects: { terrain: number; walker: number };
      asset: number;
      rootGuid: string;
      materialEncoding: unknown;
    } => typeof data === 'object' && data !== null && 'subjects' in data,
  );
  const name = `terrain-worker-${crypto.randomUUID()}`,
    channel = new BroadcastChannel(name);
  try {
    const app = (
      await createApp(
        canvas,
        {
          ...(runtimeBinding === undefined ? {} : { assetRuntimeBinding: runtimeBinding }),
          execution: {
            workers: { engine: true, render: !engineOnly, kernels: false },
            bootstrap: new URL(
              engineOnly
                ? import.meta.env.DEV
                  ? '/src/engine-only-bootstrap.ts'
                  : '/assets/terrain-engine-bootstrap.js'
                : import.meta.env.DEV
                  ? '/src/worker-bootstrap.ts'
                  : '/assets/terrain-bootstrap.js',
              location.href,
            ),
            bootstrapData: { channel: name, rootGuid: AssetGuid.format(rootGuid) },
            bootstrapPort: source.port2,
            diagnostics: { rhiCapture: true },
            startupTimeoutMs: 90000,
            frameTimeoutMs: 30000,
          },
        },
        forgeaxBundlerAdapter(),
      )
    ).unwrap();

    const subjects = await ready;
    if (subjects.rootGuid !== AssetGuid.format(rootGuid))
      throw new Error('Worker loaded a different terrain root');
    if (engineOnly) {
      if (app.remoteEval === undefined) throw new Error('Engine-only proof requires inspection');
      const inspect = app.remoteEval.bind(app);
      const snapshot = async (request?: {
        worldId: number;
        entity: number;
        x: number;
        z: number;
        expectedAsset: number;
      }) => {
        const token = crypto.randomUUID();
        const received = response<{ kind: 'engine-proof'; token: string; value: EngineProof }>(
          channel,
          (data): data is { kind: 'engine-proof'; token: string; value: EngineProof } =>
            typeof data === 'object' &&
            data !== null &&
            'kind' in data &&
            data.kind === 'engine-proof' &&
            'token' in data &&
            data.token === token &&
            'value' in data,
        );
        channel.postMessage({ kind: 'engine-proof', token, request });
        return (await received).value;
      };
      const drain = async () => {
        const deadline = performance.now() + 60000;
        while (app.execution.report().frame.inFlight !== 0) {
          if (performance.now() >= deadline)
            throw new Error('Engine-only frame credit did not drain');
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      };
      const observedErrors: { code: string; detail: unknown }[] = [];
      app.onError((error) =>
        observedErrors.push({
          code: error.code,
          detail: 'detail' in error ? error.detail : undefined,
        }),
      );
      app.start().unwrap();
      await inspect(
        `const s=world.getResource('TerrainSubjects');world.set(s.camera,world.components.resolve('Camera'),{antialias:${ANTIALIAS_TAA}}).unwrap();return true;`,
      );
      capture = () => inspect(captureScript);
      window.__verifyTerrainWorker = async () => {
        const wait = async (predicate: (proof: EngineProof) => boolean) => {
          const deadline = performance.now() + 60000;
          while (performance.now() < deadline) {
            const proof = await snapshot();
            if (predicate(proof)) return proof;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          throw new Error('Engine-only Native submission proof timed out');
        };
        await wait((proof) => proof.completedFrames >= 60);
        app.pause().unwrap();
        await drain();
        const before = await snapshot();
        const identity = app.execution.report().world.identity;
        const request = {
          worldId: 0,
          entity: subjects.subjects.terrain,
          x: 62,
          z: 62,
          expectedAsset: subjects.asset,
        };
        await snapshot(request);
        const armed = response(
          channel,
          (data): data is { kind: 'reject-armed' } =>
            typeof data === 'object' &&
            data !== null &&
            'kind' in data &&
            data.kind === 'reject-armed',
        );
        channel.postMessage({ kind: 'reject-next-submit' });
        await armed;
        app.resume().unwrap();
        const after = await wait(
          (proof) =>
            proof.failures.length === 1 &&
            proof.recoveries.length === 1 &&
            proof.completedFrames > before.completedFrames,
        );
        const failed = after.failures[0],
          retry = after.recoveries[0];
        if (
          failed === undefined ||
          retry === undefined ||
          failed.code !== 'frame-submit-rejected' ||
          !failed.query?.ok ||
          JSON.stringify(failed.before) !== JSON.stringify(failed.after) ||
          before.temporal.viewIdentity.length === 0 ||
          before.temporal.viewIdentity !== failed.before.viewIdentity ||
          before.temporal.viewIdentity !== retry.temporal.viewIdentity ||
          before.temporal.mode !== 'taa' ||
          retry.temporal.mode !== 'taa' ||
          retry.temporal.frameIndex !== 0 ||
          retry.temporal.resetReason !== 'time-discontinuity' ||
          retry.temporal.historyAttempt !== 'committed' ||
          !retry.query?.ok ||
          app.execution.report().world.identity !== identity ||
          observedErrors.length !== 1 ||
          observedErrors[0]?.code !== 'app-system-update-failed'
        )
          throw new Error(`Engine-only Native rejection proof failed: ${JSON.stringify(after)}`);
        app.pause().unwrap();
        await drain();
        const report = app.execution.report();
        if (report.frame.inFlight !== 0)
          throw new Error('Engine-only rejection leaked an in-flight frame credit');
        window.__terrainReport = {
          rootGuid: subjects.rootGuid,
          materialEncoding: subjects.materialEncoding,
          status: 'PASS',
          executionTier: 'engine-worker-local-renderer',
          before,
          after,
          errors: observedErrors,
          report,
          worldIdentity: identity,
        };
        app.resume().unwrap();
        return window.__terrainReport;
      };
      window.__prepareTerrainWorkerCapture = async () => {
        await window.__verifyTerrainWorker?.();
        window.__transmissionFrameCount = 60;
      };
      window.__disposeTerrainWorker = async () => {
        await app.dispose();
        channel.close();
        source.port1.close();
      };
      return;
    }
    const sendDelta = (delta: unknown) =>
      source.port1.postMessage({ kind: 'terrain-catalog-delta', delta });
    import.meta.hot?.on('forgeax:catalog-delta', sendDelta);
    app.start().unwrap();
    const inspect = (code: string) => {
      if (app.remoteEval === undefined)
        throw new Error('terrain Worker requires the existing inspection transport');
      return app.remoteEval(code);
    };
    capture = () => inspect(captureScript);
    const events: unknown[] = [],
      failures: unknown[] = [];
    const stateCode =
      "const subjects=world.getResource('TerrainSubjects');const c=world.get(subjects.terrain,world.components.resolve('Terrain')).unwrap();const root=world.sharedRefs.resolve(c.asset).unwrap();const walker=world.getResource('TerrainWalker');return {asset:Number(c.asset),height:root.heights[62*root.columns+62],gate:{...world.getResource('TerrainGameplayGate')},walker:{...walker},position:Array.from(world.get(subjects.walker,world.components.resolve('Transform')).unwrap().pos),physics:world.getResource('PhysicsWorld').getDerivedPublication(subjects.terrain),failures:world.getResource('TerrainWriterFailures')};";
    const state = async () => {
      const value = (await inspect(stateCode)) as { asset: number; failures: unknown[] };
      return {
        ...value,
        frameId: app.execution.report().render?.completedFrame,
        worldIdentity: app.execution.report().world.identity,
        render: app.execution.report().render,
      };
    };
    let rejectOnCatalog = false;
    const observeDelta = (delta: unknown) => {
      events.push({ kind: 'catalog', delta });
      if (rejectOnCatalog) {
        rejectOnCatalog = false;
        channel.postMessage({ kind: 'reject-next-submit' });
      }
    };
    import.meta.hot?.on('forgeax:catalog-delta', observeDelta);
    const receiveFixture = (event: MessageEvent) => {
      if (event.data?.kind === 'queue-rejected') {
        events.push({ kind: 'submit-rejected' });
      }
    };
    channel.addEventListener('message', receiveFixture);
    window.__terrainHmrProbe = {
      state,
      events,
      failures,
      submitted: () =>
        inspect(
          "const s=world.getResource('TerrainSubjects');const c=world.get(s.terrain,world.components.resolve('Terrain')).unwrap();return await world.getResource('TerrainQuery')({worldId:0,entity:s.terrain,x:62,z:62,expectedAsset:Number(c.asset)});",
        ),
      move: () => inspect("world.getResource('TerrainWalker').speed=1;return true;"),
      retry: () => inspect("world.getResource('TerrainReloadPolicy').retry();return true;"),
      rejectOnCatalog: () => {
        rejectOnCatalog = true;
      },
    };
    window.__terrainWorkerQuery = (frameId) =>
      inspect(
        `const s=world.getResource('TerrainSubjects');return await execution.querySubmittedTerrainHeight(${frameId},{worldId:0,entity:s.terrain,x:62,z:62});`,
      );
    window.__terrainWorkerReject = () => channel.postMessage({ kind: 'reject-next-submit' });
    window.__verifyTerrainWorker = async () => {
      await inspect("world.getResource('TerrainWalker').speed=1; return true;");
      const deadline = performance.now() + 60000;
      while (
        (app.execution?.report().render?.completedFrame ?? 0) < 60 &&
        performance.now() < deadline
      ) {
        if (app.lastError !== undefined) throw app.lastError;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const report = app.execution?.report();
      if ((report?.render?.completedFrame ?? 0) < 60)
        throw new Error('terrain Worker did not complete 60 frames');
      const frame = response<{ id: number; frameId: number; completed: { ok: boolean } }>(
        channel,
        (data): data is { id: number; frameId: number; completed: { ok: boolean } } =>
          typeof data === 'object' && data !== null && 'id' in data && data.id === 1,
      );
      channel.postMessage({ id: 1 });
      const captured = await frame;
      if (!captured.completed.ok) throw new Error('terrain Worker submission failed');
      const queryFrameId = app.execution?.report().render?.completedFrame;
      if (queryFrameId === undefined) throw new Error('missing submitted Source frame identity');
      const request = {
        worldId: 0,
        entity: subjects.subjects.terrain,
        x: 62,
        z: 62,
        expectedAsset: subjects.asset,
      };
      const result = await inspect(
        `const request=${JSON.stringify(request)}; const height=await execution.querySubmittedTerrainHeight(${queryFrameId},request); const wrongRoot=await execution.querySubmittedTerrainHeight(${queryFrameId},{...request,expectedAsset:${subjects.asset + 1}}); const stale=await execution.querySubmittedTerrainHeight(1,request); const gate=world.getResource('TerrainGameplayGate'); const walker=world.getResource('TerrainWalker'); const walkerPosition=Array.from(world.get(walker.entity,world.components.resolve('Transform')).unwrap().pos); const hit=world.getResource('PhysicsWorld').raycast(new Float32Array([62,50,62]),new Float32Array([0,-1,0]),100); return {height,wrongRoot,stale,gate,walker,walkerPosition,collisionHeight:hit?.point[1]};`,
      );
      const proof = result as {
        height: { ok: boolean; value?: number };
        wrongRoot: { ok: boolean };
        stale: { ok: boolean };
        gate: { blocked: boolean };
        walker: { updates: number };
        walkerPosition: number[];
        collisionHeight: number;
      };
      if (
        !proof.height.ok ||
        !Number.isFinite(proof.height.value) ||
        proof.wrongRoot.ok ||
        proof.stale.ok ||
        proof.gate.blocked ||
        proof.walker.updates === 0 ||
        Math.abs((proof.height.value ?? Infinity) - proof.collisionHeight) > 0.02
      )
        throw new Error(`terrain Worker proof failed: ${JSON.stringify(proof)}`);
      window.__terrainReport = {
        rootGuid: subjects.rootGuid,
        materialEncoding: subjects.materialEncoding,
        report,
        frameId: queryFrameId,
        rendererOrdinal: captured.frameId,
        subjects,
        result,
      };
      return window.__terrainReport;
    };
    window.__prepareTerrainWorkerCapture = async () => {
      try {
        await window.__verifyTerrainWorker?.();
        window.__transmissionFrameCount = 60;
      } catch (error) {
        const failure =
          error instanceof Error
            ? {
                name: error.name,
                message: error.message,
                ...('code' in error ? { code: error.code } : {}),
                ...('detail' in error ? { detail: error.detail } : {}),
              }
            : error;
        Object.assign(globalThis, { __forgeaxBootstrapFailure: failure });
        throw new Error(`terrain Worker capture failed: ${JSON.stringify(failure)}`, {
          cause: error,
        });
      }
    };
    window.__disposeTerrainWorker = async () => {
      import.meta.hot?.off('forgeax:catalog-delta', sendDelta);
      import.meta.hot?.off('forgeax:catalog-delta', observeDelta);
      channel.removeEventListener('message', receiveFixture);
      delete window.__terrainHmrProbe;
      delete window.__terrainWorkerQuery;
      delete window.__terrainWorkerReject;
      await app.dispose();
      channel.close();
      source.port1.close();
    };
  } catch (error) {
    channel.close();
    source.port1.close();
    throw error;
  }
}
declare global {
  interface Window {
    __terrainWorkerQuery?: (frameId: number) => Promise<unknown>;
    __terrainWorkerReject?: () => void;
    __verifyTerrainWorker?: () => Promise<unknown>;
    __prepareTerrainWorkerCapture?: () => Promise<void>;
    __disposeTerrainWorker?: () => Promise<void>;
  }
}
