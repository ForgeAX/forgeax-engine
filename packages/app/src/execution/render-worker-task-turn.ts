/** A microtask cannot deliver a pending WebGPU completion task. */
export function yieldRenderWorkerTaskTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** One reusable Worker task source, with no nested-timer delay. */
export function createRenderWorkerTaskTurns() {
  let channel: MessageChannel | undefined;
  let resume: (() => void) | undefined;
  return {
    yield(): Promise<void> {
      if (channel === undefined) {
        const owned = new MessageChannel();
        channel = owned;
        owned.port1.onmessage = () => {
          if (channel !== owned) return;
          const done = resume;
          resume = undefined;
          done?.();
        };
      }
      if (resume !== undefined) throw new Error('One active Render Worker task turn');
      const target = channel;
      return new Promise((resolve) => {
        resume = resolve;
        target.port2.postMessage(0);
      });
    },
    dispose() {
      channel?.port1.close();
      channel?.port2.close();
      channel = undefined;
      const done = resume;
      resume = undefined;
      done?.();
    },
  };
}
