import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import type { RenderSystemInternals } from '../../record/render-context';
import { ViewGraphSeal, type ViewGraphSealState } from '../graph-seal-systems';
import { createRenderWorld, renderSubmission, runRenderRecord } from '../render-world';
import * as surfaceUi from '../surface-ui-systems';
import { viewComposition } from '../view-output-systems';

it.each([
  {
    name: 'primary scene with UI startup frame offset',
    publicFrame: 17,
    sealFrame: 5,
    kind: 'display',
    primary: true,
    active: false,
    expected: true,
  },
  {
    name: 'primary scene without frame offset',
    publicFrame: 5,
    sealFrame: 5,
    kind: 'display',
    primary: true,
    active: false,
    expected: true,
  },
  {
    name: 'stale primary seal',
    publicFrame: 17,
    sealFrame: 4,
    kind: 'display',
    primary: true,
    active: false,
    expected: false,
  },
  {
    name: 'capture without surface output',
    publicFrame: 17,
    sealFrame: 5,
    kind: 'capture',
    primary: true,
    active: false,
    expected: false,
  },
  {
    name: 'UI-only frame without primary output',
    publicFrame: 17,
    sealFrame: 5,
    kind: 'display',
    primary: false,
    active: false,
    expected: false,
  },
  {
    name: 'UI-only frame after a previously encoded scene',
    publicFrame: 17,
    sealFrame: 5,
    kind: 'display',
    primary: true,
    active: false,
    open: false,
    expected: false,
  },
  {
    name: 'composed mode without an encoded compositor',
    publicFrame: 17,
    sealFrame: 5,
    kind: 'display',
    primary: true,
    active: true,
    expected: false,
  },
])('uses real surface-write evidence for $name', async (scenario) => {
  const world = createRenderWorld();
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  Object.assign(renderSubmission(world), {
    frame: 5,
    open: !('open' in scenario && scenario.open === false),
  });
  const state = {
    frame: scenario.sealFrame,
    prepared: undefined,
    outcome: undefined,
    encoding: { kind: 'encoded', value: { kind: scenario.kind } },
  } as unknown as ViewGraphSealState;
  const entity = world
    .spawn({
      component: ViewGraphSeal,
      data: { state: world.allocUniqueRef('ViewGraphSeal', state) },
    })
    .unwrap();
  // The primary fast path has no composed ViewRecorder in this list.
  expect(viewComposition(world).recorded).toEqual([]);
  viewComposition(world).active = scenario.active;
  const encode = vi.spyOn(surfaceUi, 'encodeSurfaceUi').mockImplementation(() => {});
  try {
    const internals = {
      device,
      deviceScope: { generation: 1 },
      errorRegistry: { fire: vi.fn() },
      viewEntity: scenario.primary ? entity : undefined,
    } as unknown as RenderSystemInternals;
    expect(
      runRenderRecord(world, {
        device,
        frameId: scenario.publicFrame,
        rendererInternals: internals,
        shared: true,
      }).ok,
    ).toBe(true);
    expect(encode).toHaveBeenCalledWith(
      world,
      internals,
      scenario.publicFrame,
      expect.anything(),
      scenario.expected,
    );
  } finally {
    encode.mockRestore();
  }
});
