export interface ProfileClock {
  nowMicros(): number;
}

export function createProfileClock(readMicros: () => number = defaultReadMicros): ProfileClock {
  let lastMicros = 0;
  return {
    nowMicros() {
      const currentMicros = readMicros();
      lastMicros = Math.max(lastMicros, currentMicros);
      return lastMicros;
    },
  };
}

function defaultReadMicros(): number {
  return Math.floor(globalThis.performance.now() * 1000);
}
