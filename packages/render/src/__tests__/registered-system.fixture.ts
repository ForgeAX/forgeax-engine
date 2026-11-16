import { type ScheduleToken, type SystemToken, World } from '@forgeax/engine-ecs';
import { afterEach, beforeEach, vi } from 'vitest';

// Destructive owner tests retain actual registered identities through observation.
// This never adds a name lookup to World or changes a production registration.
let registrations = new WeakMap<World, Map<ScheduleToken, Map<string, Set<SystemToken>>>>();
let restore = () => {};
beforeEach(() => {
  registrations = new WeakMap();
  const remember = (world: World, schedule: ScheduleToken, system: SystemToken) => {
    let scopes = registrations.get(world);
    if (!scopes) {
      scopes = new Map();
      registrations.set(world, scopes);
    }
    let systems = scopes.get(schedule);
    if (!systems) {
      systems = new Map();
      scopes.set(schedule, systems);
    }
    let tokens = systems.get(system.name);
    if (!tokens) {
      tokens = new Set();
      systems.set(system.name, tokens);
    }
    tokens.add(system);
  };
  const add = World.prototype.addSystem;
  const addMany = World.prototype.addSystems;
  const one = vi.spyOn(World.prototype, 'addSystem').mockImplementation(function (
    this: World,
    schedule,
    system,
  ) {
    const result = add.call(this, schedule, system);
    if (result.ok) remember(this, schedule, system);
    return result;
  });
  const many = vi.spyOn(World.prototype, 'addSystems').mockImplementation(function (
    this: World,
    schedule,
    set,
    systems,
  ) {
    const result = addMany.call(this, schedule, set, systems);
    if (result.ok) for (const system of systems) remember(this, schedule, system);
    return result;
  });
  restore = () => {
    one.mockRestore();
    many.mockRestore();
  };
});
afterEach(() => restore());

export function registeredSystem(world: World, schedule: ScheduleToken, name: string): SystemToken {
  const systems = [...(registrations.get(world)?.get(schedule)?.get(name) ?? [])].filter((system) =>
    world.hasSystem(schedule, system),
  );
  if (systems.length !== 1)
    throw new Error(
      `Expected one live fixture system ${name} in ${schedule.name}; observed ${systems.length}`,
    );
  return systems[0] as SystemToken;
}
