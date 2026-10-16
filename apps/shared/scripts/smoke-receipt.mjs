import {
  parseObservedFrameReceipt,
  parseSmokeFrameBudget,
  RECEIPT_PREFIX,
  SMOKE_MIN_FRAMES,
} from '../../../scripts/ci/run-dawn-smoke-roster.mjs';

export function smokeFrameBudget(value = process.env.SMOKE_MIN_FRAMES) {
  return parseSmokeFrameBudget(value);
}

// Call only after the owner has completed its rendering and correctness checks.
export function emitSmokeReceipt(gateId, framesObserved, commandId = 'smoke') {
  const frames = smokeFrameBudget();
  if (!Number.isSafeInteger(framesObserved) || framesObserved <= 0) {
    throw new TypeError(`framesObserved must be a positive integer; got ${String(framesObserved)}`);
  }
  if (framesObserved < frames && process.env.SMOKE_MIN_FRAMES !== undefined)
    throw new Error(`completed frames ${framesObserved} are below requested smoke frame budget ${frames}`);
  if (framesObserved < SMOKE_MIN_FRAMES) {
    process.stderr.write(
      `[forgeax-smoke-receipt] short focused run: framesObserved=${framesObserved}; ` +
        `canonical roster admission requires >=${SMOKE_MIN_FRAMES} frames; no receipt emitted\n`,
    );
    return false;
  }
  const line = `${RECEIPT_PREFIX}${JSON.stringify({
    schemaVersion: 1,
    gateId,
    commandId,
    framesObserved,
    completed: true,
  })}`;
  parseObservedFrameReceipt(line, { gateId, commandId, frames });
  process.stdout.write(`${line}\n`);
  return true;
}
