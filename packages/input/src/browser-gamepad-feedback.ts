import {
  createGamepadFeedback,
  GAMEPAD_FEEDBACK_CAPACITY,
  type GamepadFeedbackIntent,
  type GamepadFeedbackResult,
  type GamepadFeedbackStatus,
  type GamepadFeedbackTarget,
  validGamepadRumble,
} from './gamepad-feedback';
import type { RawGamepadStub } from './gamepad-frame';

interface Actuator {
  readonly effects?: readonly string[];
  readonly type?: string;
  playEffect(
    type: 'dual-rumble',
    params: {
      duration: number;
      startDelay: number;
      strongMagnitude: number;
      weakMagnitude: number;
    },
  ): Promise<string>;
  reset(): Promise<string>;
}
type NativePad = RawGamepadStub & { readonly vibrationActuator?: Actuator };
interface ActiveEffect {
  owner: number;
  finish: (status: GamepadFeedbackStatus, detail?: string) => void;
  actuator: Actuator;
}
interface Connection {
  id: string;
  generation: number;
  pad: NativePad;
  pending: number;
  resetting: number;
  active?: ActiveEffect;
}
interface Hub {
  connections: Map<number, Connection>;
  pending: number;
  owners: number;
}
// One actuator arbitration boundary per browser document. No second polling path.
const hubs = new WeakMap<object, Hub>();
let nextAttachment = 1;
let nextGeneration = 1;
const MAX_TARGET_PENDING = 8;
const SETTLE_GRACE_MS = 1000;
const MAX_RESULTS = GAMEPAD_FEEDBACK_CAPACITY * 2;

export function attachBrowserGamepadFeedback(doc: Document | undefined, win: Window | undefined) {
  const host = doc ?? win;
  let hub = host ? hubs.get(host) : undefined;
  if (!hub) {
    hub = { connections: new Map(), pending: 0, owners: 0 };
    if (host) hubs.set(host, hub);
  }
  const shared = hub;
  shared.owners++;
  let attachment = nextAttachment++;
  let detached = false;
  let lastCommand = 0;
  let results: GamepadFeedbackResult[] = [];
  let lost = 0;
  const feedback = createGamepadFeedback();
  function publish(result: GamepadFeedbackResult) {
    if (detached) {
      if (result.id === 0) feedback.acceptResults([result]);
      return;
    }
    if (results.length === MAX_RESULTS) {
      results.shift();
      lost++;
    }
    results.push(result);
  }
  function supports(pad: NativePad): boolean {
    const actuator = pad.vibrationActuator;
    return (
      !!actuator &&
      typeof actuator.playEffect === 'function' &&
      typeof actuator.reset === 'function' &&
      (actuator.effects?.includes('dual-rumble') ?? actuator.type === 'dual-rumble')
    );
  }
  function run(
    connection: Connection,
    reset: boolean,
    duration: number,
    invoke: () => Promise<string>,
    finish: ActiveEffect['finish'],
  ) {
    if (shared.pending >= GAMEPAD_FEEDBACK_CAPACITY || connection.pending >= MAX_TARGET_PENDING) {
      finish('busy', 'Native call capacity includes promises that timed out but have not settled.');
      return;
    }
    shared.pending++;
    connection.pending++;
    if (reset) connection.resetting++;
    let terminal: ActiveEffect['finish'] | undefined = finish;
    const timer = setTimeout(() => {
      terminal?.('timeout', 'Native promise did not settle before duration + 1000ms.');
      terminal = undefined;
      // Keep the native slot occupied until actual settlement. A timeout is not cancellation.
      if (!reset && connection.active?.finish === finish) stopOwned(connection, 'timeout');
    }, duration + SETTLE_GRACE_MS);
    function settled(status: GamepadFeedbackStatus, detail?: string) {
      clearTimeout(timer);
      shared.pending--;
      connection.pending--;
      if (reset) connection.resetting--;
      terminal?.(status, detail);
      terminal = undefined;
      if (connection.active?.finish === finish) delete connection.active;
    }
    try {
      const promise = invoke();
      Promise.resolve(promise).then(
        (value) =>
          settled(
            value === 'complete' ? 'complete' : value === 'preempted' ? 'preempted' : 'rejected',
            value === 'complete' || value === 'preempted'
              ? undefined
              : `Unexpected native result: ${String(value).slice(0, 256)}`,
          ),
        (cause) => settled('rejected', rejectionDetail(cause)),
      );
    } catch (cause) {
      settled('rejected', rejectionDetail(cause));
    }
  }
  function stopOwned(connection: Connection, status: GamepadFeedbackStatus) {
    const active = connection.active;
    if (!active || active.owner !== attachment) return;
    delete connection.active;
    active.finish(status);
    run(
      connection,
      true,
      0,
      () => active.actuator.reset(),
      (outcome, detail) => {
        if (outcome === 'rejected' || outcome === 'timeout' || outcome === 'busy')
          publish({ id: 0, status: outcome, detail: `Lifecycle reset: ${detail ?? outcome}` });
      },
    );
  }
  function invalidate(index: number) {
    const connection = shared.connections.get(index);
    if (!connection) return;
    connection.active?.finish('disconnected');
    delete connection.active;
    shared.connections.delete(index);
  }
  function onConnection(event: Event) {
    invalidate((event as GamepadEvent).gamepad.index);
  }
  function release() {
    for (const connection of shared.connections.values()) stopOwned(connection, 'preempted');
    // Old queued targets cannot revive an effect after a control boundary.
    attachment = nextAttachment++;
    lastCommand = 0;
  }
  function onHidden() {
    if (doc?.visibilityState === 'hidden') release();
  }
  win?.addEventListener?.('gamepaddisconnected', onConnection);
  win?.addEventListener?.('gamepadconnected', onConnection);
  doc?.addEventListener?.('visibilitychange', onHidden);

  function observe(pads: readonly RawGamepadStub[]) {
    const present = new Set(pads.map((pad) => pad.index));
    for (const index of shared.connections.keys()) if (!present.has(index)) invalidate(index);
    for (const raw of pads) {
      const pad = raw as NativePad;
      let connection = shared.connections.get(pad.index);
      if (connection && connection.id !== pad.id) {
        invalidate(pad.index);
        connection = undefined;
      }
      if (!connection) {
        connection = { id: pad.id, generation: nextGeneration++, pad, pending: 0, resetting: 0 };
        shared.connections.set(pad.index, connection);
      } else {
        connection.pad = pad;
      }
    }
  }
  function target(index: number): GamepadFeedbackTarget | undefined {
    const connection = shared.connections.get(index);
    if (!connection || detached) return undefined;
    return Object.freeze({ attachment, index, generation: connection.generation });
  }
  function dispatch(intents: readonly GamepadFeedbackIntent[]) {
    if (detached) return;
    // An oversized transport batch is rejected as one bounded loss observation.
    if (intents.length > GAMEPAD_FEEDBACK_CAPACITY) {
      lost += intents.length;
      return;
    }
    for (const intent of intents) {
      if (!Number.isSafeInteger(intent.id) || intent.id <= 0 || !intent.target) continue;
      if (intent.target.attachment !== attachment) {
        publish({ id: intent.id, status: 'stale' });
        continue;
      }
      if (intent.id <= lastCommand) continue; // Duplicate/late transport never replays native work.
      lastCommand = intent.id;
      let finished = false;
      const finish: ActiveEffect['finish'] = (status, detail) => {
        if (finished) return;
        finished = true;
        publish({ id: intent.id, status, ...(detail === undefined ? {} : { detail }) });
      };
      const connection = shared.connections.get(intent.target.index);
      if (!connection) {
        finish('disconnected');
        continue;
      }
      if (connection.generation !== intent.target.generation) {
        finish('stale');
        continue;
      }
      if (doc?.visibilityState === 'hidden') {
        finish('hidden');
        continue;
      }
      if (!supports(connection.pad)) {
        finish('unsupported');
        continue;
      }
      if (
        connection.resetting ||
        shared.pending >= GAMEPAD_FEEDBACK_CAPACITY ||
        connection.pending >= MAX_TARGET_PENDING
      ) {
        finish('busy');
        continue;
      }
      const actuator = connection.pad.vibrationActuator as Actuator;
      if (intent.kind === 'stop') {
        if (connection.active && connection.active.owner !== attachment) {
          finish('busy');
          continue;
        }
        connection.active?.finish('preempted');
        delete connection.active;
        run(connection, true, 0, () => actuator.reset(), finish);
      } else if (intent.kind === 'play' && validGamepadRumble(intent.effect)) {
        // Reserve one reset slot for every active connection, including this play.
        let activeCount = 0;
        for (const item of shared.connections.values()) if (item.active) activeCount++;
        if (
          connection.pending >= MAX_TARGET_PENDING - 1 ||
          shared.pending + activeCount + (connection.active ? 1 : 2) > GAMEPAD_FEEDBACK_CAPACITY
        ) {
          finish('busy');
          continue;
        }
        connection.active?.finish('preempted');
        connection.active = { owner: attachment, finish, actuator };
        run(
          connection,
          false,
          intent.effect.durationMs,
          () =>
            actuator.playEffect('dual-rumble', {
              duration: intent.effect.durationMs,
              startDelay: 0,
              strongMagnitude: intent.effect.strongMagnitude,
              weakMagnitude: intent.effect.weakMagnitude,
            }),
          finish,
        );
      } else {
        finish('invalid');
      }
    }
  }
  return {
    feedback,
    observe,
    target,
    supported: (index: number) => {
      const pad = shared.connections.get(index)?.pad;
      return pad ? supports(pad) : false;
    },
    dispatch,
    sampleResults() {
      dispatch(feedback.drainIntents());
      const out = results;
      results = [];
      const dropped = lost;
      lost = 0;
      return { feedbackResults: out, feedbackLostResults: dropped };
    },
    release,
    inspect: () => ({
      pendingNative: shared.pending,
      queuedResults: results.length,
      lostResults: lost,
    }),
    detach() {
      if (detached) return;
      release();
      detached = true;
      feedback.dispose();
      if (--shared.owners === 0) shared.connections.clear();
      results = [];
      win?.removeEventListener?.('gamepaddisconnected', onConnection);
      win?.removeEventListener?.('gamepadconnected', onConnection);
      doc?.removeEventListener?.('visibilitychange', onHidden);
    },
  };
}
function rejectionDetail(cause: unknown): string {
  return (cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)).slice(0, 512);
}
