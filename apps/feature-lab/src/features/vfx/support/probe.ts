import { defineFeature, type FeatureCheck } from '../../../lab/feature';
import type { LabVfx } from './vfx-stage';
import { createLabHost, setupLabVfx } from './vfx-stage';

/** Shared probe body: boot the lab effect, run `frames`, then let `probe` build checks from the live host. */
export function vfxProbe(
  meta: {
    title: string;
    catalog: string;
    summary: string;
    expect: string;
  },
  probe: (
    vfx: LabVfx,
    tools: { frames(count: number): Promise<void> },
  ) => Promise<readonly FeatureCheck[]>,
) {
  const lab = createLabHost();
  return defineFeature({
    ...meta,
    kind: 'probe',
    get appOptions() {
      return lab.appOptions;
    },
    async setup({ app, world, frames, hud }) {
      const setup = await setupLabVfx(lab, app, world);
      if (!setup.ok) {
        hud.status(setup.error);
        return { checks: () => [{ name: 'lab VFX setup', ok: false, detail: setup.error }] };
      }
      await frames(10);
      const items = await probe(setup.value, { frames });
      return { checks: () => items };
    },
  });
}

export function check(name: string, ok: boolean, detail?: unknown): FeatureCheck {
  return detail === undefined
    ? { name, ok }
    : { name, ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) };
}
