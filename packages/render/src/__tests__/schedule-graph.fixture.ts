import type { World } from '@forgeax/engine-ecs';

/** Resolve detached graph ids for assertions about the owner's diagnostic labels. */
export function dependencyNames(
  schedule: ReturnType<World['scheduleData']>[number] | undefined,
): readonly (readonly [string, string])[] {
  if (!schedule) throw new Error('Missing inspected schedule');
  const names = new Map(
    [...schedule.systems, ...schedule.anchors].map((entry) => [entry.id, entry.name]),
  );
  const name = (id: number) => {
    const value = names.get(id);
    if (value === undefined) throw new Error(`Unknown inspected system id ${id}`);
    return value;
  };
  return schedule.dependencies.map(([before, after]) => [name(before), name(after)] as const);
}
