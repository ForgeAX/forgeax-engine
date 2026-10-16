export function serializeBrowserConsoleValue(value) {
  const json = JSON.stringify(value, (_key, nested) => {
    if (!(nested instanceof Error)) return nested;
    return {
      ...nested,
      ...Object.fromEntries(
        Object.getOwnPropertyNames(nested).map((name) => [name, nested[name]]),
      ),
      name: nested.name,
      message: nested.message,
      ...(typeof nested.stack === 'string' ? { stack: nested.stack.slice(0, 4_000) } : {}),
    };
  });
  return JSON.parse(json);
}
