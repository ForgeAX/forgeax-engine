import type { PhysicsSolverParticipantInput } from '@forgeax/engine-physics';
import { runRapierSolverWorker } from './solver-worker.js';

globalThis.onmessage = async ({
  data,
}: MessageEvent<{ kind: string; processorModuleUrl: string }>) => {
  if (data.kind !== 'initialize') return;
  try {
    const processor = (await import(/* @vite-ignore */ data.processorModuleUrl)) as {
      processPhysicsSolverTask: NonNullable<PhysicsSolverParticipantInput['preSimulate']>;
    };
    await runRapierSolverWorker(processor.processPhysicsSolverTask);
  } catch (cause) {
    globalThis.postMessage({
      kind: 'initialize-failed',
      reason: cause instanceof Error ? cause.message : String(cause),
    });
  }
};
