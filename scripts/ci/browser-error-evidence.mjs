/** Bounded diagnostic retention; the caller still owns every error verdict. */
export function createBrowserErrorEvidence() {
  const records = [];
  const pending = new Set();
  let omitted = 0;
  const retain = (record) => {
    if (records.length >= 16) {
      omitted++;
      return undefined;
    }
    records.push(record);
    return record;
  };
  const pageError = (error) => {
    retain({
      kind: 'page',
      name: error.name,
      message: error.message?.slice(0, 4000),
      stack: error.stack?.slice(0, 8000),
    });
  };
  const consoleError = (message) => {
    const record = retain({
      kind: 'console',
      text: message.text().slice(0, 4000),
      location: message.location(),
      arguments: [],
    });
    if (record === undefined) return;
    const operation = Promise.all(
      message
        .args()
        .slice(0, 4)
        .map((argument) =>
          argument
            .evaluate((value) => {
              const seen = new Set();
              let nodes = 64;
              let characters = 16000;
              const serialize = (item, depth) => {
                if (nodes-- <= 0 || characters <= 0) return '[size-limit]';
                if (typeof item === 'string') {
                  const text = item.slice(0, Math.min(4000, characters));
                  characters -= text.length;
                  return text;
                }
                if (item === null || typeof item === 'boolean' || typeof item === 'number')
                  return item;
                if (typeof item !== 'object') return String(item);
                if (seen.has(item)) return '[circular]';
                if (depth === 0) return '[depth-limit]';
                seen.add(item);
                if (Array.isArray(item))
                  return item.slice(0, 16).map((entry) => serialize(entry, depth - 1));
                const keys = [
                  ...new Set([
                    'name',
                    'message',
                    'code',
                    'expected',
                    'hint',
                    'detail',
                    'cause',
                    'stack',
                    ...Object.keys(item),
                  ]),
                ].slice(0, 16);
                const result = {};
                for (const key of keys) {
                  try {
                    if (item[key] !== undefined) result[key] = serialize(item[key], depth - 1);
                  } catch {
                    result[key] = '[unavailable]';
                  }
                }
                return result;
              };
              return serialize(value, 5);
            })
            .catch((error) => ({ unavailable: error.message.slice(0, 1000) })),
        ),
    ).then((arguments_) => {
      record.arguments = arguments_;
    });
    pending.add(operation);
    void operation.finally(() => pending.delete(operation));
  };
  const snapshot = async () => {
    let timer;
    try {
      await Promise.race([
        Promise.allSettled([...pending]),
        new Promise((resolve) => {
          timer = setTimeout(resolve, 1000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    return { records, omitted, pending: pending.size };
  };
  return { pageError, consoleError, snapshot };
}
