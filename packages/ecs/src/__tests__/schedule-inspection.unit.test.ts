import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import { defineSystem } from '../schedule';
import { FixedUpdate, Update } from '../schedule-token';
import { World } from '../world';

describe('schedule-scoped inspection', () => {
  it('groups systems by their owning schedule', () => {
    const world = new World();
    const systemToken1 = defineSystem({ name: 'update-system', queries: [], fn: () => {} });
    world.addSystem(Update, systemToken1);
    const systemToken2 = defineSystem({ name: 'fixed-system', queries: [], fn: () => {} });
    world.addSystem(FixedUpdate, systemToken2);

    const inspection = world.inspect();

    expect(inspection.scheduleSystemCount(Update)).toBe(1);
    expect(inspection.scheduleSystemCount(FixedUpdate)).toBe(1);
    expect(inspection.schedules).toEqual([
      { schedule: Update, systems: [{ id: 0, name: 'update-system', sets: [] }] },
      { schedule: FixedUpdate, systems: [{ id: 0, name: 'fixed-system', sets: [] }] },
    ]);
  });

  it('projects a JSON-safe schedule graph with declared access metadata', () => {
    const Position = defineComponent('ScheduleDataPosition', { x: 'f32' });
    const Marker = defineComponent('ScheduleDataMarker', { value: 'u32' });
    const Optional = defineComponent('ScheduleDataOptional', { value: 'u32' });
    const world = new World();
    const systemToken3 = defineSystem({
      name: 'producer',
      queries: [{ write: [Position] }],
      fn: () => {},
    });
    world.addSystem(Update, systemToken3);
    const systemToken4 = defineSystem({
      name: 'consumer',
      after: [systemToken3],
      queries: [
        {
          read: [Optional],
          with: [Position],
          without: [Marker],
          optional: [Optional],
          changed: [Position],
          added: [Marker],
        },
      ],
      fn: () => {},
    });
    world.addSystem(Update, systemToken4);

    const data = world.scheduleData();
    const update = data.find((schedule) => schedule.name === 'Update');

    expect(update?.systems).toEqual([
      {
        id: 0,
        name: 'producer',
        sets: [],
        before: [],
        after: [],
        queries: [
          {
            read: [],
            write: ['ScheduleDataPosition'],
            with: [],
            without: [],
            optional: [],
            changed: [],
            added: [],
          },
        ],
        resources: [],
      },
      {
        id: 1,
        name: 'consumer',
        sets: [],
        before: [],
        after: ['producer'],
        queries: [
          {
            read: ['ScheduleDataOptional'],
            write: [],
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
    expect(update?.dependencies).toContainEqual([0, 1]);
    expect(JSON.parse(JSON.stringify(data))).toEqual(data);
  });
});
