import { Update, type World } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-render';

/** Opt-in browser proof observes the preceding App submission once per frame. */
export function installGpuDrivenEvidence(world: World, renderer: Renderer): void {
  const parameters = new URLSearchParams(location.search);
  if (!parameters.has('gpu-evidence')) return;
  if (parameters.has('gpu-ssao')) {
    const configured = renderer.setProfile({
      ...renderer.inspect().profile,
      renderPath: 'deferred',
      ssao: true,
    });
    if (!configured.ok) throw configured.error;
  }
  let lastFrame = -1;
  let frames = 0;
  const failures: string[] = [];
  let last = renderer.inspect().renderScene.gpuDriven;
  world
    .addSystem(Update, {
      name: 'gpu-driven-evidence',
      queries: [],
      fn: () => {
        const current = renderer.inspect();
        if (current.frame.frameId === lastFrame) return;
        lastFrame = current.frame.frameId;
        last = current.renderScene.gpuDriven;
        if (frames === 0 && !last.submitted) return;
        frames++;
        if (
          (!last.submitted || last.indirectDrawCount === 0 || last.cpuFallbackDrawItems !== 0) &&
          failures.length < 10
        )
          failures.push(JSON.stringify({ frame: lastFrame, gpu: last }));
      },
    })
    .unwrap();
  Object.assign(globalThis, {
    __forgeaxGpuEvidence: () => ({
      frames,
      last,
      failures,
      backend: renderer.inspect().capabilities.backendKind,
    }),
  });
}
