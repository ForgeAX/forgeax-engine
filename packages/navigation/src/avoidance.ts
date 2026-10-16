import { err, ok, type Result } from '@forgeax/engine-types';
import { invalidInput, type NavigationError } from './errors';
export interface AvoidanceAgent {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radius: number;
  readonly height: number;
  readonly vx: number;
  readonly vz: number;
  readonly desiredX: number;
  readonly desiredZ: number;
  readonly maxSpeed: number;
}
export interface AvoidanceOptions {
  readonly neighborDistance: number;
  readonly maxNeighbors: number;
  readonly horizon: number;
  /** Per-agent bucket inspection bound; saturation produces a stopped intent. */
  readonly maxCandidates: number;
}
export interface AvoidanceVelocity {
  readonly id: number;
  readonly x: number;
  readonly z: number;
  readonly neighbors: number;
  readonly saturated: boolean;
}
const DIRECTIONS = Array.from(
  { length: 24 },
  (_, i) => [Math.cos((i * Math.PI) / 12), Math.sin((i * Math.PI) / 12)] as const,
);
const EMPTY_BUCKET: readonly AvoidanceAgent[] = [];
/** Spatial hash and bounded velocity-obstacle sampling. Input order never affects ties. */
export function solveNavigationAvoidance(
  input: readonly AvoidanceAgent[],
  options: AvoidanceOptions,
  acceptVelocity?: (agent: AvoidanceAgent, x: number, z: number) => boolean,
): Result<readonly AvoidanceVelocity[], NavigationError> {
  const { neighborDistance: distance, maxNeighbors, horizon, maxCandidates } = options;
  if (
    input.length > 4096 ||
    !Number.isFinite(distance) ||
    distance <= 0 ||
    !Number.isFinite(horizon) ||
    horizon <= 0 ||
    !Number.isInteger(maxNeighbors) ||
    maxNeighbors < 1 ||
    maxNeighbors > 32 ||
    !Number.isInteger(maxCandidates) ||
    maxCandidates < maxNeighbors ||
    maxCandidates > 512
  )
    return err(
      invalidInput(
        'avoidance.options',
        options,
        'At most 4096 agents, finite positive distance/horizon, neighbors 1..32, candidates neighbors..512',
      ),
    );
  const agents = [...input].sort((a, b) => a.id - b.id),
    ids = new Set<number>(),
    buckets = new Map<string, AvoidanceAgent[]>();
  for (const a of agents) {
    if (
      ![
        a.id,
        a.x,
        a.y,
        a.z,
        a.radius,
        a.height,
        a.vx,
        a.vz,
        a.desiredX,
        a.desiredZ,
        a.maxSpeed,
      ].every(Number.isFinite) ||
      !Number.isInteger(a.id) ||
      ids.has(a.id) ||
      a.radius <= 0 ||
      a.radius > distance / 2 ||
      a.height <= 0 ||
      a.maxSpeed < 0 ||
      a.maxSpeed > 100 ||
      Math.hypot(a.vx, a.vz) > 100 ||
      Math.hypot(a.desiredX, a.desiredZ) > 100
    )
      return err(
        invalidInput(
          'avoidance.agent',
          a,
          'Unique id, finite geometry/velocity, radius <= distance/2, speed <= 100',
        ),
      );
    ids.add(a.id);
    const key = `${Math.floor(a.x / distance)}:${Math.floor(a.z / distance)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(a);
    else buckets.set(key, [a]);
  }
  const output: AvoidanceVelocity[] = [];
  for (const a of agents) {
    const neighbors: AvoidanceAgent[] = [];
    let inspected = 0,
      saturated = false;
    const cx = Math.floor(a.x / distance),
      cz = Math.floor(a.z / distance);
    search: for (let x = cx - 1; x <= cx + 1; x++)
      for (let z = cz - 1; z <= cz + 1; z++)
        for (const b of buckets.get(`${x}:${z}`) ?? EMPTY_BUCKET) {
          if (b.id === a.id) continue;
          if (++inspected > maxCandidates) {
            saturated = true;
            break search;
          }
          const d = (b.x - a.x) ** 2 + (b.z - a.z) ** 2;
          if (d <= distance * distance && Math.abs(a.y - b.y) < (a.height + b.height) / 2) {
            neighbors.push(b);
          }
        }
    neighbors.sort(
      (i, j) =>
        (i.x - a.x) ** 2 + (i.z - a.z) ** 2 - ((j.x - a.x) ** 2 + (j.z - a.z) ** 2) || i.id - j.id,
    );
    neighbors.length = Math.min(neighbors.length, maxNeighbors);
    if (saturated || a.maxSpeed === 0) {
      output.push({ id: a.id, x: 0, z: 0, neighbors: neighbors.length, saturated });
      continue;
    }
    const desiredLength = Math.hypot(a.desiredX, a.desiredZ),
      scale = desiredLength > a.maxSpeed ? a.maxSpeed / desiredLength : 1;
    const dx = a.desiredX * scale,
      dz = a.desiredZ * scale,
      preferredAllowed = !acceptVelocity || acceptVelocity(a, dx, dz);
    let bx = 0,
      bz = 0,
      best = Infinity;
    const score = (vx: number, vz: number) => {
      let cost = (vx - dx) ** 2 + (vz - dz) ** 2;
      // When movement is requested, a safe tangential escape must beat a stopped local minimum.
      if (vx === 0 && vz === 0 && desiredLength > 1e-6) cost += a.maxSpeed ** 2;
      // A small common right-hand preference resolves symmetric head-on encounters.
      cost += 0.04 * ((vx - dx - dz * 0.1) ** 2 + (vz - dz + dx * 0.1) ** 2);
      // Every contact penalty is nonnegative: a worse preference cost cannot win.
      if (cost >= best - 1e-12) return;
      for (const b of neighbors) {
        const length = Math.hypot(b.desiredX, b.desiredZ),
          scale = length > b.maxSpeed ? b.maxSpeed / length : 1,
          preferredX = b.desiredX * scale,
          preferredZ = b.desiredZ * scale,
          px = b.x - a.x,
          pz = b.z - a.z,
          r = a.radius + b.radius + 0.03,
          c = px * px + pz * pz - r * r;
        // Cooperative intent prevents resting queues becoming artificial static walls.
        // Actual velocity still guards imminent contact; Physics resolves real contact.
        for (let phase = 0; phase < 2; phase++) {
          const rx = vx - (phase === 0 ? preferredX : b.vx),
            rz = vz - (phase === 0 ? preferredZ : b.vz),
            window = phase === 0 ? horizon : Math.min(horizon, 0.1);
          if (c < 0) {
            const next = (px - rx * 0.1) ** 2 + (pz - rz * 0.1) ** 2;
            cost += 100 + 100 * Math.max(0, r * r - next);
            continue;
          }
          const aa = rx * rx + rz * rz,
            bb = px * rx + pz * rz,
            disc = bb * bb - aa * c;
          if (aa > 1e-10 && bb > 0 && disc >= 0) {
            const t = (bb - Math.sqrt(disc)) / aa;
            if (t < window) cost += 100 * (1 - t / window) ** 2;
          }
        }
      }
      if (
        cost < best - 1e-12 &&
        ((vx === 0 && vz === 0) ||
          (vx === dx && vz === dz
            ? preferredAllowed
            : !acceptVelocity || acceptVelocity(a, vx, vz)))
      ) {
        best = cost;
        bx = vx;
        bz = vz;
      }
    };
    score(dx, dz);
    score(0, 0);
    for (let index = 0; index < DIRECTIONS.length; index++) {
      const direction = DIRECTIONS[index] as readonly [number, number],
        x = direction[0],
        z = direction[1];
      score(x * a.maxSpeed, z * a.maxSpeed);
      score(x * a.maxSpeed * 0.5, z * a.maxSpeed * 0.5);
    }
    output.push({ id: a.id, x: bx, z: bz, neighbors: neighbors.length, saturated });
  }
  return ok(output);
}
