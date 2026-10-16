import {
  type AcousticRoutes,
  acousticFailure,
  validateAcousticRoutes,
} from '@forgeax/engine-audio';
import { type AudioError, ok, type Result } from '@forgeax/engine-types';

interface RouteNode {
  readonly node: GainNode;
  from: number;
  to: number;
  start: number;
}

/** Retained crossfade taps into the existing bus graph; no separate bus/effect topology. */
export class SourceBusRoutes {
  private readonly nodes = new Map<string, RouteNode>();
  private automatic: AcousticRoutes = { fallback: 1, buses: [] };
  private base: string;
  constructor(
    private readonly context: BaseAudioContext,
    private readonly output: AudioNode,
    base: string,
    private readonly input: (bus: string) => GainNode | undefined,
  ) {
    this.base = base;
  }
  get busIds(): string[] {
    return [...this.nodes.keys()];
  }
  private value(route: RouteNode, now: number): number {
    return (
      route.from + (route.to - route.from) * Math.max(0, Math.min(1, (now - route.start) / 0.01))
    );
  }
  private ramp(route: RouteNode, value: number, initial: boolean): void {
    const now = this.context.currentTime;
    const from = initial ? value : this.value(route, now);
    route.node.gain.cancelScheduledValues(now);
    route.node.gain.setValueAtTime(from, now);
    if (!initial) route.node.gain.linearRampToValueAtTime(value, now + 0.01);
    route.from = from;
    route.to = value;
    route.start = now;
  }
  update(automatic: AcousticRoutes, base = this.base, initial = false): Result<void, AudioError> {
    const checked = validateAcousticRoutes(automatic);
    if (!checked.ok) return checked;
    const targets = new Map<string, number>([[base, automatic.fallback]]);
    for (const route of automatic.buses)
      targets.set(route.bus, (targets.get(route.bus) ?? 0) + route.gain);
    if ([...targets.keys()].some((id) => !this.input(id)))
      return acousticFailure('source region references an unconfigured bus');
    const added: string[] = [];
    try {
      for (const id of targets.keys())
        if (!this.nodes.has(id)) {
          const node = this.context.createGain();
          node.gain.value = 0;
          this.nodes.set(id, { node, from: 0, to: 0, start: this.context.currentTime });
          added.push(id);
          this.output.connect(node);
          const target = this.input(id);
          if (!target) throw new Error('configured acoustic bus disappeared');
          node.connect(target);
        }
    } catch (cause) {
      for (const id of added) {
        const route = this.nodes.get(id);
        if (!route) continue;
        this.output.disconnect(route.node);
        route.node.disconnect();
        this.nodes.delete(id);
      }
      return acousticFailure(`source route connection failed: ${String(cause)}`);
    }
    for (const [id, route] of this.nodes) this.ramp(route, targets.get(id) ?? 0, initial);
    this.base = base;
    this.automatic = structuredClone(automatic);
    return ok(undefined);
  }
  setBase(bus: string): Result<void, AudioError> {
    return this.update(this.automatic, bus);
  }
  reconnect(input: (id: string) => GainNode | undefined): void {
    for (const [id, route] of this.nodes) {
      const next = input(id);
      if (!next) throw new Error('retained acoustic bus missing from candidate');
      route.node.disconnect();
      route.node.connect(next);
    }
  }
  dispose(): void {
    for (const route of this.nodes.values()) {
      this.output.disconnect(route.node);
      route.node.disconnect();
    }
    this.nodes.clear();
  }
}
