import { defineFeature, type FeatureCheck } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

export default defineFeature({
  title: 'GPU pass timing',
  catalog: 'GPU pass timing',
  kind: 'probe',
  appOptions: { gpuPassTiming: { maxPassesPerFrame: 64, retentionFrames: 8 } },
  summary:
    'gpuPassTiming opt-in plus observe(receipt, { include: ["timings"] }) returns bounded per-pass GPU facts for that exact receipt.',
  expect:
    'Timings resolve to one of complete/partial/unavailable/failed with a consistent payload; without include, timings stay undefined.',
  async setup({ app, world, frames }) {
    spawnStage(world);
    spawnMesh(world, MESH.cube, standard(world, { baseColor: [0.2, 0.8, 0.3, 1] }), {
      pos: [0, 0.6, 0],
    });
    type Receipt = Parameters<typeof app.renderer.observe>[0];
    const receipts: Receipt[] = [];
    const unsubscribe = app.renderer.subscribe((event) => {
      if (event.kind === 'frame-submitted' && receipts.length < 4) receipts.push(event.receipt);
    });
    await frames(6);
    unsubscribe();
    const receipt = receipts.at(-1);
    const observed =
      receipt === undefined
        ? undefined
        : await app.renderer.observe(receipt, { include: ['timings'] });
    const bare =
      receipts[0] === undefined
        ? undefined
        : await app.renderer.observe(receipts[0], { include: [] });
    return {
      checks() {
        const items: FeatureCheck[] = [
          { name: 'frame-submitted delivered a receipt', ok: receipt !== undefined },
        ];
        if (observed === undefined || !observed.ok) {
          items.push({
            name: 'observe(receipt) ok',
            ok: false,
            detail: observed?.ok === false ? observed.error.code : 'no receipt',
          });
          return items;
        }
        const timings = observed.value.timings;
        items.push({ name: 'timings present when requested', ok: timings !== undefined });
        if (timings === undefined) return items;
        switch (timings.status) {
          case 'complete':
          case 'partial': {
            const frame = timings.frame;
            const measured = frame.passes.filter((pass) => pass.status === 'measured');
            items.push({
              name: `status ${timings.status}`,
              ok: true,
              detail: `backend=${frame.backendKind} passes=${frame.passes.length}`,
            });
            items.push({
              name: 'frame bound to the observed receipt',
              ok: frame.frameId === receipt?.frameId,
            });
            items.push({
              name: 'pass count within maxPassesPerFrame 64',
              ok: frame.passes.length > 0 && frame.passes.length <= 64,
            });
            items.push({
              name: 'measured durations are finite and non-negative',
              ok: measured.every(
                (pass) =>
                  Number.isFinite(pass.durationNanoseconds) && pass.durationNanoseconds >= 0,
              ),
              detail: measured
                .map((pass) => `${pass.passName}=${pass.durationNanoseconds}`)
                .slice(0, 6)
                .join(' '),
            });
            break;
          }
          case 'unavailable':
            items.push({
              name: 'status unavailable carries a reason code',
              ok: typeof timings.reason.code === 'string',
              detail: `${timings.reason.code} ${JSON.stringify(timings.capability)}`,
            });
            break;
          case 'failed':
            items.push({
              name: 'status failed',
              ok: false,
              detail: `${timings.error.code}: ${timings.error.hint}`,
            });
            break;
        }
        items.push({
          name: 'observe without include omits timings',
          ok: bare?.ok === true && bare.value.timings === undefined,
        });
        return items;
      },
    };
  },
});
