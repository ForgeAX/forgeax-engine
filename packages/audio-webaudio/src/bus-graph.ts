import {
  type AcousticEnvironment,
  type AcousticParameter,
  type AudioBus,
  AudioError,
  prepareAudioBuses,
  validateAcousticEnvironment,
} from '@forgeax/engine-audio';
import { err, ok, type Result } from '@forgeax/engine-types';

interface BusNodes {
  readonly input: GainNode;
  readonly dry: GainNode;
  readonly wet: GainNode;
  readonly mix: GainNode;
  readonly fader: GainNode;
  readonly effects: readonly AudioNode[];
  readonly sends: readonly GainNode[];
  readonly lowPass: Map<string, BiquadFilterNode>;
}
type LowPassControl = { readonly cutoffHz: number; readonly q: number };
function validLowPass(filter: LowPassControl | null): boolean {
  return (
    filter === null ||
    (Number.isFinite(filter.cutoffHz) &&
      filter.cutoffHz >= 20 &&
      filter.cutoffHz <= 24000 &&
      Number.isFinite(filter.q) &&
      filter.q >= 0 &&
      filter.q <= 30)
  );
}

interface BusState {
  readonly definition: AudioBus;
  volume?: number;
  muted?: boolean;
  effect?: { build: (ctx: BaseAudioContext) => readonly AudioNode[]; wet: number };
  sendGains?: Map<string, number>;
  nodes?: BusNodes;
  lowPass?: Map<string, { readonly cutoffHz: number; readonly q: number }>;
}

function failure(reason: string): Result<never, AudioError> {
  return err(
    new AudioError({
      code: 'control-failed',
      expected: 'a valid Host bus graph',
      hint: 'inspect the bus references and supply exclusive nodes from this AudioContext',
      detail: { code: 'control-failed', reason },
    }),
  );
}

/** One accepted graph; candidates are disconnected from the output until commit. */
export class BusGraph {
  private buses = new Map<string, BusState>();
  private ctx: BaseAudioContext | undefined;
  private environment: readonly AcousticEnvironment[] = [];
  constructor(definitions: readonly AudioBus[]) {
    const result = this.replace(definitions);
    if (!result.ok) throw result.error;
  }
  has(id: string): boolean {
    return this.buses.has(id);
  }
  setLowPass(
    id: string,
    owner: string,
    filter: { readonly cutoffHz: number; readonly q: number } | null,
  ): Result<void, AudioError> {
    const bus = this.buses.get(id);
    if (!bus || !owner || owner.length > 128 || !validLowPass(filter))
      return failure('invalid owned bus low-pass control');
    bus.lowPass ??= new Map();
    const controls = bus.lowPass;
    if (filter !== null && !controls.has(owner) && controls.size >= 32)
      return failure('at most 32 owned low-pass filters per bus');
    const existing = bus.nodes?.lowPass.get(owner);
    if (filter !== null && existing) {
      controls.set(owner, { ...filter });
      const now = this.ctx?.currentTime ?? 0;
      existing.frequency.setTargetAtTime(
        Math.min(filter.cutoffHz, (this.ctx?.sampleRate ?? 48000) / 2),
        now,
        0.01,
      );
      existing.Q.setTargetAtTime(filter.q, now, 0.01);
      return ok(undefined);
    }
    // Build the new node before touching the audible chain. Controls also work
    // before the lazy context exists and survive accepted graph replacement.
    let added: BiquadFilterNode | undefined;
    if (filter !== null && this.ctx) {
      try {
        added = this.ctx.createBiquadFilter();
        added.type = 'lowpass';
        added.frequency.value = Math.min(filter.cutoffHz, this.ctx.sampleRate / 2);
        added.Q.value = filter.q;
      } catch (cause) {
        return failure(String(cause));
      }
    }
    if (filter === null) controls.delete(owner);
    else controls.set(owner, { ...filter });
    this.rewireLowPass(bus, owner, filter, added);
    return ok(undefined);
  }
  private rewireLowPass(
    bus: BusState,
    owner: string,
    filter: LowPassControl | null,
    added: BiquadFilterNode | undefined,
  ): void {
    const nodes = bus.nodes;
    if (nodes) {
      for (const node of nodes.lowPass.values()) node.disconnect();
      nodes.mix.disconnect();
      if (filter === null) nodes.lowPass.delete(owner);
      else if (added) nodes.lowPass.set(owner, added);
      let tail: AudioNode = nodes.mix;
      for (const node of nodes.lowPass.values()) {
        tail.connect(node);
        tail = node;
      }
      tail.connect(nodes.fader);
      // Pre-fader sends share the mix tap and must be reattached after rewiring.
      (bus.definition.sends ?? []).forEach((send, index) => {
        if (send.tap === 'pre-fader') {
          const sendNode = nodes.sends[index];
          if (!sendNode) throw new Error('Audio bus send graph is incomplete');
          nodes.mix.connect(sendNode);
        }
      });
    }
  }
  input(id: string): GainNode | undefined {
    return this.buses.get(id)?.nodes?.input;
  }
  owns(node: AudioNode): boolean {
    for (const bus of this.buses.values()) {
      const nodes = bus.nodes;
      if (nodes && [...this.allNodes(nodes)].includes(node)) return true;
    }
    return false;
  }
  attach(ctx: BaseAudioContext): void {
    if (this.ctx) return;
    const candidate = this.build(this.buses, ctx);
    if (!candidate.ok) throw candidate.error;
    this.ctx = ctx;
    for (const bus of this.buses.values())
      if (bus.definition.parent === null) bus.nodes?.fader.connect(ctx.destination);
  }
  replace(
    definitions: readonly AudioBus[],
    retained: readonly string[] = [],
    reconnect: (input: (id: string) => GainNode | undefined) => void = () => {},
  ): Result<void, AudioError> {
    const checked = prepareAudioBuses(definitions);
    if (!checked.ok) return checked;
    const candidate = new Map<string, BusState>();
    for (const definition of checked.value) {
      const previous = this.buses.get(definition.id);
      candidate.set(definition.id, {
        definition,
        ...(previous?.volume === undefined ? {} : { volume: previous.volume }),
        ...(previous?.muted === undefined ? {} : { muted: previous.muted }),
        ...(previous?.effect ? { effect: previous.effect } : {}),
        ...(previous?.sendGains ? { sendGains: new Map(previous.sendGains) } : {}),
        ...(previous?.lowPass ? { lowPass: new Map(previous.lowPass) } : {}),
      });
    }
    if (retained.some((id) => !candidate.has(id)))
      return failure('cannot remove a bus used by a retained source');
    const environmentCheck = this.checkEnvironment(this.environment, candidate);
    if (!environmentCheck.ok) return environmentCheck;
    if (this.ctx) {
      const built = this.build(candidate, this.ctx);
      if (!built.ok) return built;
      try {
        reconnect((id) => candidate.get(id)?.nodes?.input);
        for (const bus of candidate.values())
          if (bus.definition.parent === null) bus.nodes?.fader.connect(this.ctx.destination);
      } catch (cause) {
        this.disconnect(candidate);
        reconnect((id) => this.input(id));
        return failure(String(cause));
      }
    }
    const previous = this.buses;
    this.buses = candidate;
    this.disconnect(previous);
    return ok(undefined);
  }
  private checkEnvironment(
    environment: readonly AcousticEnvironment[],
    buses = this.buses,
  ): Result<void, AudioError> {
    const checked = validateAcousticEnvironment(environment);
    if (!checked.ok) return checked;
    for (const control of environment) {
      const bus = buses.get(control.bus);
      if (
        !bus ||
        (control.wet && !bus.effect) ||
        control.sends.some(
          (send) => !(bus.definition.sends ?? []).some((s) => s.bus === send.target),
        )
      )
        return failure('region environment requires an accepted bus effect and existing sends');
    }
    return ok(undefined);
  }
  setEnvironment(environment: readonly AcousticEnvironment[]): Result<void, AudioError> {
    const checked = this.checkEnvironment(environment);
    if (!checked.ok) return checked;
    this.environment = structuredClone(environment);
    for (const bus of this.buses.values()) this.applyEnvironment(bus, false);
    return ok(undefined);
  }
  setWet(id: string, wet: number): Result<void, AudioError> {
    const bus = this.buses.get(id);
    if (!bus?.effect || !Number.isFinite(wet) || wet < 0 || wet > 1)
      return failure('missing effect bus or wet outside 0..1');
    bus.effect.wet = wet;
    this.applyEnvironment(bus, false);
    return ok(undefined);
  }
  setSend(id: string, target: string, gain: number): Result<void, AudioError> {
    const bus = this.buses.get(id);
    if (
      !bus ||
      !(bus.definition.sends ?? []).some((s) => s.bus === target) ||
      !Number.isFinite(gain) ||
      !Number.isFinite(Math.fround(gain)) ||
      gain < 0
    )
      return failure('missing send or gain outside finite non-negative native float range');
    bus.sendGains ??= new Map();
    bus.sendGains.set(target, gain);
    this.applyEnvironment(bus, false);
    return ok(undefined);
  }
  private applyEnvironment(bus: BusState, initial: boolean): void {
    if (!bus.nodes) return;
    const control = this.environment.find((e) => e.bus === bus.definition.id);
    const blend = (base: number, p: AcousticParameter | undefined) => {
      if (!p) return base;
      const weight = Math.min(1, p.weight);
      return base * (1 - weight) + p.value * weight;
    };
    const wet = bus.nodes.effects.length ? blend(bus.effect?.wet ?? 1, control?.wet) : 0;
    const write = (node: GainNode, value: number) => {
      if (initial) node.gain.value = value;
      else this.ramp(node, value);
    };
    write(bus.nodes.wet, wet);
    write(bus.nodes.dry, 1 - wet);
    (bus.definition.sends ?? []).forEach((send, index) => {
      const node = bus.nodes?.sends[index];
      if (node)
        write(
          node,
          blend(
            bus.sendGains?.get(send.bus) ?? send.gain,
            control?.sends.find((s) => s.target === send.bus)?.gain,
          ),
        );
    });
  }
  effects(
    id: string,
    build: (ctx: BaseAudioContext) => readonly AudioNode[],
    wet: number,
    retained: readonly string[],
    reconnect: (input: (id: string) => GainNode | undefined) => void,
  ): Result<void, AudioError> {
    const bus = this.buses.get(id);
    if (!bus || !Number.isFinite(wet) || wet < 0 || wet > 1)
      return failure('missing bus or wet outside 0..1');
    const previous = bus.effect;
    bus.effect = { build, wet };
    const result = this.replace(
      [...this.buses.values()].map((bus) => bus.definition),
      retained,
      reconnect,
    );
    if (!result.ok) {
      if (previous) bus.effect = previous;
      else delete bus.effect;
    }
    return result;
  }
  volume(id: string, volume: number): Result<void, AudioError> {
    const bus = this.buses.get(id);
    if (!bus || !Number.isFinite(volume) || !Number.isFinite(Math.fround(volume)) || volume < 0)
      return failure('missing bus or invalid volume');
    bus.volume = volume;
    bus.muted = false;
    if (bus.nodes) {
      this.ramp(bus.nodes.fader, volume);
      this.ramp(bus.nodes.mix, 1);
    }
    return ok(undefined);
  }
  mute(id: string, muted: boolean): Result<void, AudioError> {
    const bus = this.buses.get(id);
    if (!bus) return failure('missing bus');
    bus.muted = muted;
    // Mute after effects too: shared effect tails and every send become silent.
    if (bus.nodes) this.ramp(bus.nodes.mix, muted ? 0 : 1);
    return ok(undefined);
  }
  dispose(): void {
    this.disconnect(this.buses);
    this.ctx = undefined;
  }
  private ramp(node: GainNode, target: number): void {
    const now = this.ctx?.currentTime ?? 0;
    if (node.gain.cancelAndHoldAtTime) {
      node.gain.cancelAndHoldAtTime(now);
      // A new ramp starts at this control time, including after an earlier
      // ramp has ended. Holding alone does not insert that start event.
      node.gain.setValueAtTime(node.gain.value, now);
    } else {
      node.gain.cancelScheduledValues(now);
      node.gain.setValueAtTime(node.gain.value, now);
    }
    node.gain.linearRampToValueAtTime(target, now + 0.01);
  }
  private *allNodes(nodes: BusNodes): Iterable<AudioNode> {
    yield nodes.input;
    yield nodes.dry;
    yield nodes.wet;
    yield nodes.mix;
    yield nodes.fader;
    yield* nodes.effects;
    yield* nodes.sends;
    yield* nodes.lowPass.values();
  }
  private disconnect(buses: Map<string, BusState>): void {
    for (const bus of buses.values()) {
      if (bus.nodes) for (const node of this.allNodes(bus.nodes)) node.disconnect();
      delete bus.nodes;
    }
  }
  private buildBus(bus: BusState, ctx: BaseAudioContext, owned: Set<AudioNode>): void {
    const input = ctx.createGain(),
      dry = ctx.createGain(),
      wet = ctx.createGain(),
      mix = ctx.createGain(),
      fader = ctx.createGain();
    const lowPass = new Map<string, BiquadFilterNode>();
    bus.nodes = { input, dry, wet, mix, fader, effects: [], sends: [], lowPass };
    const effects = [...(bus.effect?.build(ctx) ?? [])];
    if (
      effects.length > 32 ||
      new Set(effects).size !== effects.length ||
      effects.some(
        (node) =>
          node.context !== ctx ||
          node.numberOfInputs < 1 ||
          node.numberOfOutputs < 1 ||
          owned.has(node) ||
          this.owns(node),
      )
    )
      throw new Error('effects must be at most 32 exclusive input/output nodes');
    for (const node of effects) owned.add(node);
    const sends = (bus.definition.sends ?? []).map(() => ctx.createGain());
    bus.nodes = { input, dry, wet, mix, fader, effects, sends, lowPass };
    const amount = effects.length ? (bus.effect?.wet ?? 1) : 0;
    dry.gain.value = 1 - amount;
    wet.gain.value = amount;
    mix.gain.value = (bus.muted ?? bus.definition.muted ?? false) ? 0 : 1;
    fader.gain.value = bus.volume ?? bus.definition.volume ?? 1;
    input.connect(dry);
    dry.connect(mix);
    if (effects[0]) {
      input.connect(effects[0]);
      effects.forEach((node, index) => {
        node.connect(effects[index + 1] ?? wet);
      });
      wet.connect(mix);
    }
    let tail: AudioNode = mix;
    for (const [owner, filter] of bus.lowPass ?? []) {
      const node = ctx.createBiquadFilter();
      node.type = 'lowpass';
      node.frequency.value = Math.min(filter.cutoffHz, ctx.sampleRate / 2);
      node.Q.value = filter.q;
      lowPass.set(owner, node);
      tail.connect(node);
      tail = node;
    }
    tail.connect(fader);
  }
  private build(buses: Map<string, BusState>, ctx: BaseAudioContext): Result<void, AudioError> {
    const owned = new Set<AudioNode>();
    try {
      for (const bus of buses.values()) {
        this.buildBus(bus, ctx, owned);
      }
      const nodesOf = (id: string): BusNodes => {
        const nodes = buses.get(id)?.nodes;
        if (!nodes) throw new Error('candidate bus nodes missing');
        return nodes;
      };
      for (const bus of buses.values()) {
        const nodes = nodesOf(bus.definition.id);
        if (bus.definition.parent !== null)
          nodes.fader.connect(nodesOf(bus.definition.parent).input);
        (bus.definition.sends ?? []).forEach((send, index) => {
          const gain = nodes.sends[index];
          if (!gain) throw new Error('candidate send node missing');
          gain.gain.value = send.gain;
          (send.tap === 'pre-fader' ? nodes.mix : nodes.fader).connect(gain);
          gain.connect(nodesOf(send.bus).input);
        });
        this.applyEnvironment(bus, true);
      }
      return ok(undefined);
    } catch (cause) {
      this.disconnect(buses);
      return failure(String(cause));
    }
  }
}
