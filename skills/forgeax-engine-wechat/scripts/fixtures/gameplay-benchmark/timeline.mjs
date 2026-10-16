export const PHASE_NAMES = ['walk', 'run', 'jump', 'run-jump'];
export const CONTACT_IDS = { move: 1, look: 2, run: 3, jump: 4 };

function requireValue(condition, message) {
  if (!condition) throw new Error(`Gameplay input: ${message}`);
}

/** Full contact snapshots; omitted IDs are released, never implicitly retained. */
export function validateTimeline(value) {
  requireValue(value?.schemaVersion === 'forgeax-gameplay-input/1', 'unsupported schema');
  const space = value.coordinateSpace;
  requireValue(['css-px', 'device-px'].includes(space?.unit), 'coordinate unit required');
  requireValue(
    Number.isInteger(space.width) &&
      space.width > 0 &&
      Number.isInteger(space.height) &&
      space.height > 0,
    'positive integer extent required',
  );
  requireValue(
    Number.isFinite(value.durationMs) && value.durationMs >= 1 && value.durationMs <= 120000,
    'duration outside 1..120000 ms',
  );
  requireValue(Array.isArray(value.phases) && value.phases.length === 4, 'four phases required');
  let boundary = 0;
  for (let index = 0; index < value.phases.length; index++) {
    const phase = value.phases[index];
    requireValue(
      phase.name === PHASE_NAMES[index] &&
        phase.startMs === boundary &&
        Number.isFinite(phase.endMs) &&
        phase.endMs > boundary,
      'ordered contiguous phases required',
    );
    boundary = phase.endMs;
  }
  requireValue(boundary === value.durationMs, 'phases must cover duration');
  requireValue(
    Array.isArray(value.events) && value.events.length >= 2 && value.events.length <= 20000,
    'bounded events required',
  );
  let previous = -1;
  for (const event of value.events) {
    requireValue(
      Number.isFinite(event.atMs) &&
        event.atMs > previous &&
        event.atMs >= 0 &&
        event.atMs <= value.durationMs,
      'strict event time ordering required',
    );
    previous = event.atMs;
    requireValue(
      Array.isArray(event.contacts) && event.contacts.length <= 4,
      'at most four contacts',
    );
    const ids = new Set();
    for (const contact of event.contacts) {
      requireValue(
        CONTACT_IDS[contact.role] === contact.id && !ids.has(contact.id),
        'unique role IDs required',
      );
      ids.add(contact.id);
      requireValue(
        Number.isFinite(contact.x) &&
          contact.x >= 0 &&
          contact.x < space.width &&
          Number.isFinite(contact.y) &&
          contact.y >= 0 &&
          contact.y < space.height,
        'contact outside extent',
      );
      if (space.unit === 'device-px')
        requireValue(
          Number.isInteger(contact.x) && Number.isInteger(contact.y),
          'device coordinates must be integers',
        );
    }
  }
  requireValue(value.events[0].atMs === 0, 'initial snapshot required');
  const last = value.events.at(-1);
  requireValue(
    last.atMs === value.durationMs && last.contacts.length === 0,
    'final release at duration required',
  );
  return value;
}

/** Geometry must come from a current native UI inspection in the stated space. */
export function createGameplayTimeline({
  geometry,
  coordinateSpace,
  buttonPoints = {},
  phaseMs = 10000,
  stepMs = 1000 / 60,
}) {
  requireValue(
    Number.isInteger(phaseMs) && phaseMs >= 1000 && phaseMs <= 30000,
    'phase duration outside 1000..30000 ms',
  );
  requireValue(Number.isFinite(stepMs) && stepMs >= 10 && stepMs <= 100, 'step outside 10..100 ms');
  for (const role of Object.keys(CONTACT_IDS)) {
    const rect = geometry[role];
    requireValue(
      rect &&
        ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(rect[key])) &&
        rect.width > 4 &&
        rect.height > 4,
      `missing ${role} geometry`,
    );
    requireValue(
      rect.x >= 0 &&
        rect.y >= 0 &&
        rect.x + rect.width <= coordinateSpace.width &&
        rect.y + rect.height <= coordinateSpace.height,
      `${role} geometry outside extent`,
    );
  }
  const contact = (role, x, y) => ({
    id: CONTACT_IDS[role],
    role,
    x: coordinateSpace.unit === 'device-px' ? Math.round(x) : x,
    y: coordinateSpace.unit === 'device-px' ? Math.round(y) : y,
  });
  const center = (role) =>
    contact(
      role,
      geometry[role].x + geometry[role].width / 2,
      geometry[role].y + geometry[role].height / 2,
    );
  requireValue(
    buttonPoints &&
      typeof buttonPoints === 'object' &&
      !Array.isArray(buttonPoints) &&
      Object.keys(buttonPoints).every((role) => role === 'run' || role === 'jump'),
    'buttonPoints must contain only run/jump points',
  );
  const selectedButtonPoints = {},
    buttons = {};
  for (const role of ['run', 'jump']) {
    const point = Object.hasOwn(buttonPoints, role) ? buttonPoints[role] : { u: 0.5, v: 0.5 };
    requireValue(
      point &&
        typeof point === 'object' &&
        !Array.isArray(point) &&
        Object.keys(point).length === 2 &&
        ['u', 'v'].every((key) => Number.isFinite(point[key]) && point[key] > 0 && point[key] < 1),
      `${role} button point requires only u/v strictly between 0 and 1`,
    );
    const rect = geometry[role];
    const selected = contact(role, rect.x + rect.width * point.u, rect.y + rect.height * point.v);
    requireValue(
      selected.x > rect.x &&
        selected.x < rect.x + rect.width &&
        selected.y > rect.y &&
        selected.y < rect.y + rect.height,
      `${role} button point rounds outside the real rectangle interior`,
    );
    selectedButtonPoints[role] = { u: point.u, v: point.v };
    buttons[role] = selected;
  }
  const phases = PHASE_NAMES.map((name, index) => ({
    name,
    startMs: index * phaseMs,
    endMs: (index + 1) * phaseMs,
  }));
  const events = [];
  const look = geometry.look;
  const travel = Math.min(
    look.width * 0.65,
    Math.min(coordinateSpace.width, coordinateSpace.height) * 0.3,
  );
  const sweepSteps = Math.max(4, Math.round(1000 / stepMs));
  for (const phase of phases) {
    for (let step = 0; step * stepMs < phaseMs - 1e-7; step++) {
      const local = step * stepMs;
      const contacts = [];
      if (phase.name !== 'jump') {
        const move = center('move');
        // Forward-only running leaves the ordinary game's finite ground.
        // Keep real movement speed while returning every 250 ms; do not move
        // the World or inspect it inside the timed window.
        const direction = Math.floor((phase.startMs + local + 1e-7) / 250) % 2 === 0 ? 1 : -1;
        move.y -= Math.min(geometry.move.width, geometry.move.height) * 0.3 * direction;
        if (coordinateSpace.unit === 'device-px') move.y = Math.round(move.y);
        contacts.push(move);
      }
      const sweep = Math.round((phase.startMs + local) / stepMs) % (sweepSteps + 1);
      // A real release between sweeps re-centers the finger without reversing yaw.
      if (sweep < sweepSteps)
        contacts.push(
          contact(
            'look',
            look.x + look.width / 2 - travel / 2 + (travel * sweep) / (sweepSteps - 1),
            look.y + look.height / 2,
          ),
        );
      if (phase.name === 'run' || phase.name === 'run-jump') contacts.push({ ...buttons.run });
      if (
        (phase.name === 'jump' || phase.name === 'run-jump') &&
        local % 900 >= 200 &&
        local % 900 < 350
      )
        contacts.push({ ...buttons.jump });
      events.push({ atMs: phase.startMs + local, contacts });
    }
  }
  return validateTimeline({
    schemaVersion: 'forgeax-gameplay-input/1',
    workload: 'shuttle-250ms/1',
    coordinateSpace,
    buttonPoints: selectedButtonPoints,
    durationMs: phaseMs * 4,
    phases,
    events: [...events, { atMs: phaseMs * 4, contacts: [] }],
  });
}
