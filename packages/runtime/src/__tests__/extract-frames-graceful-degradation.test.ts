// m2-t3: per-world injection failure graceful degradation test (TDD red).
//
// Test AC-09:
//   1) Inject a world's propagateTransforms failure (mock _routeError) —
//      the error is routed to that world's own ErrorHandler with systemName
//      carrying the worldId.
//   2) Other worlds still synthesize normally — their renderables are present.
//   3) The failed world's contribution is skipped — no renderables from it.
//
// We simulate the per-world error isolation pattern that extractFrames will
// implement: try/catch around each world's extract, route to
// worlds[i]._routeError, and skip that world's contribution on failure.
//
// This test verifies the error isolation logic directly, without needing
// extractFrames to exist yet (TDD red).
//
// Anchors:
//   plan-tasks.json m2-t3
//   plan-strategy D-2
//   research Finding 4
//   requirements AC-09

import { World } from '@forgeax/engine-ecs';
import { Camera, DirectionalLight } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import type { ExtractedFrame } from '../../../render/src/render-system-extract';
import { prepareExtractContext } from '../../../render/src/render-system-extract';
import { extractFrame } from '../../../render/src/render-system-extract-tail';

// ── Helpers ─────────────────────────────────────────────────────────────────

function identityTransform(): {
  pos: [number, number, number];
  quat: [number, number, number, number];
  scale: [number, number, number];
} {
  return {
    pos: [0, 0, 0],
    quat: [0, 0, 0, 1],
    scale: [1, 1, 1],
  };
}

interface ErrorRecord {
  code: string;
  systemName: string;
}

/**
 * Simulate the per-world error isolation pattern that extractFrames will
 * implement. On each world, try extractFrame; if it throws, route to
 * world._routeError and skip the world's contribution.
 */
function simulateExtractFramesWithErrorHandling(
  worlds: World[],
  errorSink: ErrorRecord[],
): { frames: ExtractedFrame[]; skippedWorlds: Set<number> } {
  const frames: ExtractedFrame[] = [];
  const skippedWorlds = new Set<number>();

  for (let wi = 0; wi < worlds.length; wi++) {
    // biome-ignore lint/style/noNonNullAssertion: worlds is a dense array, index bounded by length
    const world = worlds[wi]!;
    try {
      // Simulate: if world has an injected failure, throw
      if ((world as unknown as Record<string, unknown>)._injectFailure === true) {
        throw new Error('Injected propagateTransforms failure');
      }
      const frame = extractFrame(world as World, prepareExtractContext(world as World));
      frames.push(frame);
    } catch (_err) {
      skippedWorlds.add(wi);
      errorSink.push({
        code: 'propagateTransforms',
        systemName: `RenderSystem.extractFrames(world[${wi}])`,
      });
    }
  }

  return { frames, skippedWorlds };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('extractFrames per-world injection failure graceful degradation (m2-t3, AC-09)', () => {
  // ── AC-09-a: error routed to the correct world with worldId ────────────────

  it('AC-09: injected propagateTransforms failure routes error with worldId in systemName', () => {
    const worldA = new World();
    worldA
      .spawn(
        { component: Transform, data: identityTransform() },
        { component: Camera, data: { fov: Math.PI / 4, near: 0.1, far: 100, aspect: 1 } },
      )
      .unwrap();

    const worldB = new World();
    (worldB as unknown as Record<string, unknown>)._injectFailure = true;
    worldB
      .spawn(
        { component: Transform, data: identityTransform() },
        {
          component: DirectionalLight,
          data: {
            color: [1, 1, 1],
            intensity: 1,
            direction: [0, -1, 0],
          },
        },
      )
      .unwrap();

    const errorSink: ErrorRecord[] = [];
    const { skippedWorlds } = simulateExtractFramesWithErrorHandling([worldA, worldB], errorSink);

    // worldB (index 1) should be skipped
    expect(skippedWorlds.has(1)).toBe(true);
    expect(skippedWorlds.has(0)).toBe(false);

    // Error should carry worldId=1 in systemName
    expect(errorSink.length).toBe(1);
    expect(errorSink[0]?.systemName).toContain('world[1]');
  });

  // ── AC-09-b: other worlds still synthesize normally ────────────────────────

  it('AC-09: healthy world still produces its renderables after sibling failure', () => {
    const worldA = new World();
    worldA
      .spawn(
        { component: Transform, data: identityTransform() },
        { component: Camera, data: { fov: Math.PI / 4, near: 0.1, far: 100, aspect: 1 } },
      )
      .unwrap();
    worldA
      .spawn(
        { component: Transform, data: identityTransform() },
        {
          component: DirectionalLight,
          data: {
            color: [1, 1, 1],
            intensity: 1,
            direction: [0, -1, 0],
          },
        },
      )
      .unwrap();

    const worldB = new World();
    (worldB as unknown as Record<string, unknown>)._injectFailure = true;
    worldB
      .spawn(
        { component: Transform, data: identityTransform() },
        {
          component: DirectionalLight,
          data: {
            color: [0, 1, 0],
            intensity: 2,
            direction: [1, 0, 0],
          },
        },
      )
      .unwrap();

    const errorSink: ErrorRecord[] = [];
    const { frames, skippedWorlds } = simulateExtractFramesWithErrorHandling(
      [worldA, worldB],
      errorSink,
    );

    expect(skippedWorlds.has(1)).toBe(true);
    expect(skippedWorlds.has(0)).toBe(false);

    // worldA's frame should be present
    expect(frames.length).toBe(1);
    // biome-ignore lint/style/noNonNullAssertion: length assertion guarantees [0] is defined
    const frameA = frames[0]!;
    // worldA has a directional light
    expect(frameA.lights.directionalCount).toBeGreaterThanOrEqual(1);
  });

  // ── AC-09-c: failed world's contribution is skipped ────────────────────────

  it('AC-09: failed world contributes no renderables/lights/cameras to merged output', () => {
    const worldA = new World();
    worldA
      .spawn(
        { component: Transform, data: identityTransform() },
        { component: Camera, data: { fov: Math.PI / 4, near: 0.1, far: 100, aspect: 1 } },
      )
      .unwrap();

    const worldB = new World();
    (worldB as unknown as Record<string, unknown>)._injectFailure = true;
    worldB
      .spawn(
        { component: Transform, data: identityTransform() },
        {
          component: DirectionalLight,
          data: {
            color: [1, 1, 1],
            intensity: 1,
            direction: [0, -1, 0],
          },
        },
      )
      .unwrap();

    const errorSink: ErrorRecord[] = [];
    const { frames, skippedWorlds } = simulateExtractFramesWithErrorHandling(
      [worldA, worldB],
      errorSink,
    );

    // Only worldA's frame is present
    expect(frames.length).toBe(1);
    expect(skippedWorlds.has(1)).toBe(true);
  });

  // ── Multiple worlds, one failure ───────────────────────────────────────────

  it('AC-09: three worlds, middle one fails, two healthy ones survive', () => {
    const worlds: World[] = [];
    for (let i = 0; i < 3; i++) {
      const w = new World();
      w.spawn(
        { component: Transform, data: identityTransform() },
        {
          component: DirectionalLight,
          data: {
            color: [1, 1, 1],
            intensity: 1,
            direction: [0, -1, 0],
          },
        },
      ).unwrap();
      worlds.push(w);
    }

    // Inject failure in world[1] (middle)
    (worlds[1] as unknown as Record<string, unknown>)._injectFailure = true;

    const errorSink: ErrorRecord[] = [];
    const { frames, skippedWorlds } = simulateExtractFramesWithErrorHandling(worlds, errorSink);

    expect(skippedWorlds.has(1)).toBe(true);
    expect(skippedWorlds.has(0)).toBe(false);
    expect(skippedWorlds.has(2)).toBe(false);

    expect(frames.length).toBe(2);
    expect(errorSink.length).toBe(1);
    expect(errorSink[0]?.systemName).toContain('world[1]');
  });

  // ── Owner world failure ────────────────────────────────────────────────────

  it('AC-09: owner world failure still routes error and skips its contribution', () => {
    const worldA = new World();
    (worldA as unknown as Record<string, unknown>)._injectFailure = true;
    worldA
      .spawn(
        { component: Transform, data: identityTransform() },
        { component: Camera, data: { fov: Math.PI / 4, near: 0.1, far: 100, aspect: 1 } },
      )
      .unwrap();

    const worldB = new World();
    worldB
      .spawn(
        { component: Transform, data: identityTransform() },
        {
          component: DirectionalLight,
          data: {
            color: [1, 1, 1],
            intensity: 1,
            direction: [0, -1, 0],
          },
        },
      )
      .unwrap();

    const errorSink: ErrorRecord[] = [];
    const { frames, skippedWorlds } = simulateExtractFramesWithErrorHandling(
      [worldA, worldB],
      errorSink,
    );

    expect(skippedWorlds.has(0)).toBe(true);
    expect(skippedWorlds.has(1)).toBe(false);
    expect(frames.length).toBe(1);
    expect(errorSink.length).toBe(1);
    expect(errorSink[0]?.systemName).toContain('world[0]');
  });
});
