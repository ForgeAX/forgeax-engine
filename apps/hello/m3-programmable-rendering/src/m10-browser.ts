import { World } from '@forgeax/engine-ecs';
import { Camera, type RenderFeature } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { createRenderer } from '@forgeax/engine-runtime';
import { ok } from '@forgeax/engine-types';

const WIDTH = 64;
const HEIGHT = 64;
const canvas = document.querySelector<HTMLCanvasElement>('#m10-render-feature');
if (canvas === null) throw new Error('M10 browser canvas is missing');
canvas.width = WIDTH;
canvas.height = HEIGHT;

type FaultState = { repaired: boolean };

function makeWorld(): World {
  const world = new World();
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    {
      component: Camera,
      data: {
        fov: Math.PI / 4,
        aspect: 1,
        near: 0.1,
        far: 100,
        clearColor: [0.18, 0.08, 0.03, 1],
      },
    },
  );
  return world;
}

function makeFeature(identity: string, state: FaultState): RenderFeature<undefined> {
  return {
    identity,
    extract: () => ok(undefined),
    plan: () => {
      if (!state.repaired) {
        throw new Error(`${identity} declarative plan is intentionally unavailable`);
      }
      return ok({ work: [] });
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function hasFeaturePlanFailure(
  entry: { readonly code: string; readonly detail: unknown },
  identity: string,
): boolean {
  const detail = isRecord(entry.detail) ? entry.detail : undefined;
  const cause = isRecord(detail?.cause) ? detail.cause : undefined;
  const causeDetail = isRecord(cause?.detail) ? cause.detail : undefined;
  return cause?.code === 'render-feature-stage-failed' && causeDetail?.featureIdentity === identity;
}

const states = new Map<string, FaultState>([
  ['m10.browser.plan-a', { repaired: false }],
  ['m10.browser.plan-b', { repaired: false }],
  ['m10.browser.plan-c', { repaired: false }],
]);
const features = [...states.entries()].map(([identity, state]) => makeFeature(identity, state));
const created = await createRenderer(
  canvas,
  { features },
  { shaderManifestUrl: '/shaders/manifest.json' },
);
if (!created.ok) throw new Error(`M10 browser renderer creation failed: ${String(created.error)}`);
const renderer = created.value;
const errors: Array<{ code: string; hint: string; detail: unknown }> = [];
renderer.subscribe((event) => {
  if (event.kind !== 'error') return;
  errors.push({
    code: event.error.code,
    hint: event.error.hint,
    detail: 'detail' in event.error ? event.error.detail : undefined,
  });
});

const world = makeWorld();
const attached = renderer.attach(world);
if (!attached.ok) throw attached.error;
world.update().unwrap();
const frame = {
  leases: [attached.value],
  camera: { lease: attached.value },
  environment: { lease: attached.value },
};
const firstDraw = renderer.draw(frame);
const firstErrors = errors.slice();
for (const state of states.values()) state.repaired = true;
const secondDraw = renderer.draw(frame);
for (const draw of [firstDraw, secondDraw]) {
  if (!draw.ok) continue;
  const completed = await draw.value.completed;
  if (!completed.ok) throw completed.error;
}

for (const identity of states.keys()) {
  const failure = firstErrors.find((entry) => hasFeaturePlanFailure(entry, identity));
  if (failure === undefined || failure.hint.length === 0) {
    throw new Error(`M10 browser ${identity} plan failure was not observable: ${JSON.stringify({ firstErrors })}`);
  }
}
if (!firstDraw.ok || !secondDraw.ok) {
  throw new Error(`M10 browser draw recovery failed: ${JSON.stringify({ firstDraw, secondDraw })}`);
}

const evidence = {
  status: 'pass',
  backend: 'browser-webgpu',
  firstErrors,
  featureIdentities: renderer.inspect().features,
  firstDraw: { frameId: firstDraw.value.frameId },
  secondDraw: { frameId: secondDraw.value.frameId },
  recovery: 'next-frame declarative plan retry',
  cleanup: undefined as { disposeCalls: number } | undefined,
};
await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const browserGlobals = globalThis as typeof globalThis & {
  __forgeaxM10Dispose?: () => void;
  __forgeaxM10Evidence?: unknown;
};
browserGlobals.__forgeaxM10Evidence = evidence;
browserGlobals.__forgeaxM10Dispose = () => {
  void renderer.dispose().then(() => {
    void renderer.dispose();
    evidence.cleanup = { disposeCalls: 2 };
    browserGlobals.__forgeaxM10Evidence = evidence;
  });
};
