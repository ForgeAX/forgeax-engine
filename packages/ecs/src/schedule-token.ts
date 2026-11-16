/** Schedule identity is independent of its diagnostic label. */
const SCHEDULE_ID = Symbol.for('forgeax.ecs.schedule.identity');
export interface ScheduleToken {
  readonly [SCHEDULE_ID]: true;
  readonly name: string;
}

export function defineSchedule(name: string): ScheduleToken {
  if (name.length === 0) throw new RangeError('A schedule requires a diagnostic name');
  return Object.freeze({ name, [SCHEDULE_ID]: true as const });
}

export const Update = defineSchedule('Update');
export const FixedUpdate = defineSchedule('FixedUpdate');

export function isScheduleToken(value: unknown): value is ScheduleToken {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Partial<ScheduleToken>)[SCHEDULE_ID] === true
  );
}
export function isDomainSchedule(value: unknown): value is ScheduleToken {
  return isScheduleToken(value) && value !== Update && value !== FixedUpdate;
}
