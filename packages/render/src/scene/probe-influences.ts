import { R_MIN } from '@forgeax/engine-types';
import type { ProbeBlendContributor, ProbeSceneProbeInput } from './probe-blend';

interface Influence extends ProbeBlendContributor {
  readonly position: ProbeSceneProbeInput['position'];
  distance: number;
  rank: number;
  lower: number;
  prefixUpper: number;
}

/** The current probe field owns its finite SH, stable admission order and radius intervals.
 * A receiver borrows the active list until the next query. Retained terms copy the distance. */
export class ProbeInfluences {
  private readonly ordered: Influence[] = [];
  private readonly intervals: Influence[];
  private readonly active: Influence[] = [];
  private readonly axis: 0 | 1 | 2;

  constructor(probes: readonly ProbeSceneProbeInput[]) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const probe of probes) {
      if (
        !probe.admitted ||
        !Number.isFinite(probe.radius) ||
        probe.radius < R_MIN ||
        !Number.isFinite(probe.position[0]) ||
        !Number.isFinite(probe.position[1]) ||
        !Number.isFinite(probe.position[2]) ||
        probe.irradiance.length !== 27
      )
        continue;
      let valid = true;
      for (let i = 0; i < 27; i++)
        if (!Number.isFinite(probe.irradiance[i])) {
          valid = false;
          break;
        }
      if (!valid) continue;
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i] as number, probe.position[i] as number);
        max[i] = Math.max(max[i] as number, probe.position[i] as number);
      }
      this.ordered.push({ ...probe, distance: 0, rank: 0, lower: 0, prefixUpper: 0 });
    }
    const spans = max.map((value, i) => value - (min[i] as number));
    const xy = (spans[1] as number) > (spans[0] as number) ? 1 : 0;
    this.axis = (spans[2] as number) > (spans[xy] as number) ? 2 : xy;
    this.ordered.sort((a, b) => a.identity.localeCompare(b.identity));
    for (let i = 0; i < this.ordered.length; i++) {
      const probe = this.ordered[i] as Influence;
      probe.rank = i;
      probe.lower = probe.position[this.axis] - probe.radius;
    }
    this.intervals = this.ordered.slice().sort((a, b) => a.lower - b.lower);
    let upper = -Infinity;
    for (const probe of this.intervals) {
      upper = Math.max(upper, probe.position[this.axis] + probe.radius);
      probe.prefixUpper = upper;
    }
  }

  at(position: readonly [number, number, number]): readonly ProbeBlendContributor[] {
    const active = this.active;
    active.length = 0;
    const coordinate = position[this.axis];
    let lo = 0;
    let hi = this.intervals.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if ((this.intervals[mid] as Influence).lower <= coordinate) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo - 1; i >= 0; i--) {
      const probe = this.intervals[i] as Influence;
      if (probe.prefixUpper < coordinate) break;
      const x = position[0] - probe.position[0];
      const y = position[1] - probe.position[1];
      const z = position[2] - probe.position[2];
      const radius = probe.radius;
      if (Math.abs(x) >= radius || Math.abs(y) >= radius || Math.abs(z) >= radius) continue;
      const distance = Math.hypot(x, y, z);
      if (!(distance < radius)) continue;
      probe.distance = distance;
      active.push(probe);
    }
    if (active.length === this.ordered.length) return this.ordered;
    return active.sort(byAdmissionOrder);
  }
}

function byAdmissionOrder(a: Influence, b: Influence): number {
  return a.rank - b.rank;
}
