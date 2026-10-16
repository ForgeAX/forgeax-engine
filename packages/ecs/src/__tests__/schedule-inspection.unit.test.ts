import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import { FixedUpdate, Update } from '../schedule-token';
import { World } from '../world';

describe('schedule-scoped inspection', () => {
  it('groups systems by their owning schedule', () => {
    const world = new World();
    world.addSystem(Update, { name: 'update-system', queries: [], fn: () => {} });
    world.addSystem(FixedUpdate, { name: 'fixed-system', queries: [], fn: () => {} });

    const inspection = world.inspect();

    expect(inspection.scheduleSystemCount(Update)).toBe(1);
    expect(inspection.scheduleSystemCount(FixedUpdate)).toBe(1);
    expect(inspection.schedules).toEqual([
      { schedule: Update, systems: [{ name: 'update-system', sets: [] }] },
      { schedule: FixedUpdate, systems: [{ name: 'fixed-system', sets: [] }] },
    ]);
  });

  it('projects a JSON-safe schedule graph with declared access metadata', () => {
    const Position = defineComponent('ScheduleDataPosition', { x: 'f32' });
    const Marker = defineComponent('ScheduleDataMarker', { value: 'u32' });
    const Optional = defineComponent('ScheduleDataOptional', { value: 'u32' });
    const world = new World();
    world.addSystem(Update, {
      name: 'producer',
      queries: [{ with: [Position] }],
      fn: () => {},
    });
    world.addSystem(Update, {
      name: 'consumer',
      after: ['producer'],
      queries: [
        {
          with: [Position],
          without: [Marker],
          optional: [Optional],
          changed: [Position],
          added: [Marker],
        },
      ],
      fn: () => {},
    });

    const data = world.scheduleData();
    const update = data.find((schedule) => schedule.name === 'Update');

    expect(update?.systems).toEqual([
      {
        name: 'producer',
        sets: [],
        before: [],
        after: [],
        queries: [
          { with: ['ScheduleDataPosition'], without: [], optional: [], changed: [], added: [] },
        ],
        resources: [],
      },
      {
        name: 'consumer',
        sets: [],
        before: [],
        after: ['producer'],
        queries: [
          {
            with: ['ScheduleDataPosition'],
            without: ['ScheduleDataMarker'],
            optional: ['ScheduleDataOptional'],
            changed: ['ScheduleDataPosition'],
            added: ['ScheduleDataMarker'],
          },
        ],
        resources: [],
      },
    ]);
    expect(update?.dependencies).toContainEqual(['producer', 'consumer']);
    expect(JSON.parse(JSON.stringify(data))).toEqual(data);
  });
});
