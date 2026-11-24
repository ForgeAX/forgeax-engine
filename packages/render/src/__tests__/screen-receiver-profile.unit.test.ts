import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it } from 'vitest';
import { createScreenReceiverProfile } from '../assembly/renderer-facade';
import { DeviceScope } from '../lifecycle';
import type { StandardProfile } from '../pipeline/standard-profile';
import { DEFAULT_STANDARD_PROFILE } from '../pipeline/standard-profile';
import { SCREEN_PROBE_DEFAULTS } from '../raytracing/screen-probe-plan';
import type { PipelineState, RenderSystemInternals } from '../record/render-context';
import { ViewRecorder } from '../world/render-views';
import { createRenderWorld, renderSubmission } from '../world/render-world';
import type { ViewRecorderState } from '../world/view-output-systems';
import { ViewRecordContextState } from '../world/view-record-context';
import type { ViewSettlementOwner } from '../world/view-settlement';

const profile = {
  ...DEFAULT_STANDARD_PROFILE,
  diffuseGi: { gather: 'screen-probe', probes: SCREEN_PROBE_DEFAULTS },
} as unknown as StandardProfile;

it('locks the whole view frame and reuses the derived profile across stable software frames', () => {
  let required = false,
    reads = 0;
  const select = createScreenReceiverProfile(() => {
    reads++;
    return required;
  });
  expect(select(profile, 1, 1, 1)).toBe(profile);
  required = true;
  expect(select(profile, 1, 1, 1)).toBe(profile);
  const software = select(profile, 2, 1, 1);
  expect(software?.visibleSurface).toBe(true);
  for (let frame = 3; frame < 10; frame++) expect(select(profile, frame, 1, 1)).toBe(software);
  expect(reads).toBe(9);
  required = false;
  expect(select(profile, 10, 1, 1)).toBe(profile);
});

it('does not share demand across views or retain it over device and configuration authority changes', () => {
  let required = true;
  const software = createScreenReceiverProfile(() => required),
    hardware = createScreenReceiverProfile(() => false);
  const first = software(profile, 1, 1, 1);
  expect(hardware(profile, 1, 1, 1)).toBe(profile);
  required = false;
  expect(software(profile, 1, 1, 2)).toBe(profile);
  required = true;
  const editable = { ...profile };
  const before = software(editable, 2, 1, 2);
  editable.pbr = !editable.pbr;
  // A new accepted install, not shallow identity, authorizes the replacement.
  const after = software(editable, 2, 2, 2);
  expect(after).not.toBe(before);
  expect(after?.pbr).toBe(editable.pbr);
  expect(after?.visibleSurface).toBe(true);
  expect(first?.visibleSurface).toBe(true);
});

it('routes the real view context demand and rejects retired or replaced device owners', async () => {
  const world = createRenderWorld();
  const entity = world.spawn().unwrap();
  const scope = DeviceScope.create(1, 'screen-receiver-profile');
  let traversal = 'ray-query';
  const root = {
    renderWorld: world,
    device: (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap(),
    standardProfile: profile,
    errorRegistry: { fire: () => {} },
  } as unknown as RenderSystemInternals;
  const viewport = { x: 0, y: 0, width: 32, height: 32, renderWidth: 32, renderHeight: 32 };
  const owner = {
    frameState: {
      installedPipelineHandle: 1,
      irradianceField: {
        get plannedTraversal() {
          return traversal;
        },
      },
    },
  } as unknown as ViewSettlementOwner;
  const context = new ViewRecordContextState(
    root,
    entity,
    scope,
    1,
    viewport,
    { perPassResources: {} } as PipelineState,
    undefined,
    undefined,
    owner,
  );
  const view = {
    retired: false,
    scope,
    owner,
  } as unknown as ViewRecorderState;
  world
    .addComponent(entity, {
      component: ViewRecorder,
      data: {
        state: world.allocUniqueRef('ViewRecorder', view),
      },
    })
    .unwrap();
  try {
    expect(context.standardProfile).toBe(profile);
    traversal = 'global-sdf';
    expect(context.standardProfile).toBe(profile);
    renderSubmission(world).frame++;
    const software = context.standardProfile;
    expect(software?.visibleSurface).toBe(true);
    renderSubmission(world).frame++;
    expect(context.standardProfile).toBe(software);
    view.retired = true;
    expect(context.standardProfile).toBe(profile);
    world.removeComponent(entity, ViewRecorder).unwrap();
    const replacementScope = DeviceScope.create(1, 'replacement-device');
    try {
      const replacement = { ...view, retired: false, scope: replacementScope };
      world
        .addComponent(entity, {
          component: ViewRecorder,
          data: {
            state: world.allocUniqueRef('ViewRecorder', replacement),
          },
        })
        .unwrap();
      expect(context.standardProfile).toBe(profile);
    } finally {
      replacementScope.dispose();
    }
  } finally {
    scope.dispose();
  }
});
