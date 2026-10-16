import { openReplay } from '@forgeax/engine/rhi-debug';
import { defineFeature, type FeatureCheck } from '../../lab/feature';
import { spawnStage } from '../../lab/stage';
import { firstPixel, freshReplayBackend, recordSolidFrame, TAPE_COLOR } from './_shared/rhi-tape';

export default defineFeature({
  title: 'Per-draw inspect',
  catalog: 'Per-draw inspect',
  kind: 'probe',
  summary:
    'inspectWork(workIndex, fields) answers pipeline, bindings, and attachment pixels for one draw; readResourceAtWork reads a bound resource at that point.',
  expect:
    'Work 0 reports vs/fs entry points, the uniform binding at group 0 binding 0, the tinted attachment, and the uniform bytes; an out-of-range work index is a structured error.',
  async setup({ world }) {
    spawnStage(world);
    const recorded = await recordSolidFrame().catch((error: unknown) =>
      error instanceof Error ? error.message : String(error),
    );
    if (typeof recorded === 'string') {
      return {
        checks: (): FeatureCheck[] => [{ name: 'record frame', ok: false, detail: recorded }],
      };
    }
    const session = await openReplay(recorded.tape, await freshReplayBackend());
    if (!session.ok) {
      const code = session.error.code;
      return { checks: (): FeatureCheck[] => [{ name: 'openReplay', ok: false, detail: code }] };
    }
    const inspected = await session.value.inspectWork(0, ['bindings', 'pipeline', 'pixels']);
    const binding = inspected.ok
      ? inspected.value.bindings?.find((b) => b.groupIndex === 0 && b.binding === 0)
      : undefined;
    const uniform =
      binding?.resourceId === undefined || binding.resourceId === null
        ? undefined
        : await session.value.readResourceAtWork(binding.resourceId, 0);
    const outOfRange = await session.value.inspectWork(99, ['pixels']);
    await session.value.dispose();
    return {
      checks(): FeatureCheck[] {
        if (!inspected.ok)
          return [{ name: 'inspectWork(0)', ok: false, detail: inspected.error.code }];
        const entryPoints = (inspected.value.pipeline?.shaders ?? [])
          .map((s) => s.entryPoint)
          .join(',');
        const tint =
          uniform?.ok === true
            ? [...new Float32Array(uniform.value.bytes.slice(0, 16).buffer)].map((v) =>
                Math.round(v * 255),
              )
            : [];
        return [
          {
            name: 'pipeline available with vs/fs',
            ok: inspected.value.pipeline?.status === 'available' && entryPoints === 'vs,fs',
            detail: entryPoints,
          },
          {
            name: 'uniform binding at group 0 binding 0',
            ok: binding !== undefined && binding.resourceKind !== null,
            detail: JSON.stringify(binding),
          },
          {
            name: 'attachment pixels show the tint',
            ok:
              inspected.value.attachment !== undefined &&
              JSON.stringify(firstPixel(inspected.value.attachment.bytes)) ===
                JSON.stringify([...TAPE_COLOR]),
            detail:
              inspected.value.attachment === undefined
                ? 'none'
                : JSON.stringify(firstPixel(inspected.value.attachment.bytes)),
          },
          {
            name: 'readResourceAtWork returns the uniform bytes',
            ok: JSON.stringify(tint) === JSON.stringify([...TAPE_COLOR]),
            detail: uniform?.ok === false ? uniform.error.code : JSON.stringify(tint),
          },
          {
            name: 'work 99 is a structured error',
            ok: !outOfRange.ok,
            detail: outOfRange.ok ? 'ok' : outOfRange.error.code,
          },
        ];
      },
    };
  },
});
