// @forgeax/engine-state -- registerStatesPlugin unit tests (M2 / m2w1)
//
// Covers: idempotency, one complete resource injected with correct initial values,
// transitionStatesSystem registered, AC-09 assemble-form auto-register,
// AC-10 manual removeResource fail-fast (resource presence check).
//
// Decision anchors:
// - plan-strategy D-3: dual-form auto-register (state plugin only)
// - requirements AC-09/AC-10: assemble auto-register + fail-fast on manual remove
// - requirements C-3: setNextState returns Result.err, not throw
//
// Note: AC-09/AC-10 setNextState-error-path tests are in set-next-state.test.ts (m2w3)
// because setNextState lands in m2w4. Here we verify only the registerStatesPlugin
// side effects: Resource presence and idempotency.

import { describe, expect, it } from 'vitest';
import { World } from '@forgeax/engine-ecs';
import { defineState } from '../src/define-state';
import { type StatePayload, stateResourceKey } from '../src/resources';
import { registerStatesPlugin } from '../src/register-plugin';

const TestState = defineState('TestState', ['alpha', 'beta', 'gamma'] as const);

describe('registerStatesPlugin', () => {
  it('inserts one complete resource (current / next / previous) with correct initial values', () => {
    const world = new World();
    registerStatesPlugin(world);

    const sKey = stateResourceKey(TestState);

    expect(world.hasResource(sKey)).toBe(true);

    // Current state = variant index (defaultValue = variants[0] = 'alpha' -> 0)
    expect(world.getResource<StatePayload>(sKey).current).toBe(0);

    // Next request = undefined (no pending transition)
    expect(world.getResource<StatePayload>(sKey).next).toBeUndefined();

    // PreviousCurrent state = variant index (defaultValue = variants[0] = 'alpha' -> 0)
    expect(world.getResource<StatePayload>(sKey).previous).toBe(0);
  });

  it('is idempotent — second call is a silent no-op', () => {
    const world = new World();
    registerStatesPlugin(world);

    // Capture state after first call
    const sKey = stateResourceKey(TestState);
    const firstStateValue = world.getResource<StatePayload>(sKey).current;

    // Second call must not throw, not overwrite incorrectly, not double-register
    registerStatesPlugin(world);

    expect(world.getResource<StatePayload>(sKey).current).toBe(firstStateValue);

    // System count should remain the same (no duplicate system registration)
    const systems = world.inspect().systems;
    const transitionStatesSystems = systems.filter((s) => s.name === 'transitionStates');
    expect(transitionStatesSystems).toHaveLength(1);
  });

  it('registers transitionStatesSystem in the schedule', () => {
    const world = new World();
    registerStatesPlugin(world);

    const systems = world.inspect().systems;
    const found = systems.some((s) => s.name === 'transitionStates');
    expect(found).toBe(true);
  });

  it('AC-09: the resource is present after registerStatesPlugin (assemble-form ready for setNextState calls)', () => {
    // Simulate the assemble-form path: host creates World, calls registerStatesPlugin,
    // then the complete state resource can be read. The transition tests exercise requests through the public API.
    const world = new World();
    registerStatesPlugin(world);

    const sKey = stateResourceKey(TestState);

    expect(world.hasResource(sKey)).toBe(true);

    // State Resource has valid default value
    expect(world.getResource<StatePayload>(sKey).current).toBe(0);

    // Next request is undefined (no pending transition)
    expect(world.getResource<StatePayload>(sKey).next).toBeUndefined();
  });

  it('AC-10: manual removeResource — ResourceNotPresent after removal, throw on getResource', () => {
    const world = new World();
    registerStatesPlugin(world);

    // Manually remove the State Resource to simulate external tampering
    const sKey = stateResourceKey(TestState);
    world.removeResource(sKey);

    // Resource is no longer present
    expect(world.hasResource(sKey)).toBe(false);

    // getResource on removed key throws (ECS fail-fast)
    expect(() => world.getResource(sKey)).toThrow();
  });

  it('registerStatesPlugin is idempotent across multiple tokens', () => {
    const TokenA = defineState('TokenA', ['x', 'y'] as const);
    const TokenB = defineState('TokenB', ['p', 'q'] as const);

    const world = new World();
    registerStatesPlugin(world);

    // A complete resource exists for each token
    expect(world.hasResource(stateResourceKey(TokenA))).toBe(true);
    expect(world.hasResource(stateResourceKey(TokenB))).toBe(true);

    // Second call — no errors, resource unchanged
    registerStatesPlugin(world);
    expect(world.hasResource(stateResourceKey(TokenA))).toBe(true);
    expect(world.hasResource(stateResourceKey(TokenB))).toBe(true);
  });

  it('owns late token registration and reverses the complete runtime', () => {
    const world = new World();
    const dispose = registerStatesPlugin(world);
    const LateToken = defineState('RegisterPluginLateToken', ['cold', 'hot'] as const);

    expect(world.hasResource(stateResourceKey(LateToken))).toBe(true);
    expect(world.inspect().systems.some((system) => system.name === 'transitionStates')).toBe(true);

    dispose();
    expect(world.hasResource(stateResourceKey(LateToken))).toBe(false);
    expect(world.inspect().systems.some((system) => system.name === 'transitionStates')).toBe(false);
  });
});
