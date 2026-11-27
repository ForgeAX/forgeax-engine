/** Missing fixture data is an invalid experiment, never an expected black pixel. */
export function sceneValue<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('Required GI fixture data is missing');
  return value;
}
