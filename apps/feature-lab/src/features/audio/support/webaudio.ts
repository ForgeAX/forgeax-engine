export function makeWav(frequency: number, seconds: number, sampleRate = 8000): Uint8Array {
  const samples = Math.max(1, Math.round(seconds * sampleRate));
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i += 1) {
    view.setInt16(
      44 + i * 2,
      Math.round(Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 12000),
      true,
    );
  }
  return bytes;
}

export interface AudioGraphTrace {
  readonly edges: Array<{ from: AudioNode; to: AudioNode | AudioParam }>;
  readonly disconnected: Set<AudioNode>;
  readonly ramps: Map<AudioParam, number>;
  readonly started: AudioBufferSourceNode[];
  readonly contexts: Set<BaseAudioContext>;
  readonly closed: Set<BaseAudioContext>;
  decodes: number;
  inputsOf(node: AudioNode | AudioParam): AudioNode[];
  outputsOf(node: AudioNode): Array<AudioNode | AudioParam>;
  restore(): void;
}

type Patchable = Record<string, unknown>;

export function traceAudioGraph(): AudioGraphTrace {
  const undo: Array<() => void> = [];
  const patch = <T extends object>(
    proto: T,
    key: string,
    wrap: (original: (...args: never[]) => unknown) => (...args: never[]) => unknown,
  ) => {
    const target = proto as Patchable;
    const original = target[key] as (...args: never[]) => unknown;
    target[key] = wrap(original);
    undo.push(() => {
      target[key] = original;
    });
  };
  const trace: AudioGraphTrace = {
    edges: [],
    disconnected: new Set(),
    ramps: new Map(),
    started: [],
    contexts: new Set(),
    closed: new Set(),
    decodes: 0,
    inputsOf: (node) =>
      trace.edges
        .filter((edge) => edge.to === node && !trace.disconnected.has(edge.from))
        .map((edge) => edge.from),
    outputsOf: (node) =>
      trace.disconnected.has(node)
        ? []
        : trace.edges.filter((edge) => edge.from === node).map((edge) => edge.to),
    restore: () => {
      for (const step of undo.reverse()) step();
    },
  };
  patch(
    AudioNode.prototype,
    'connect',
    (original) =>
      function (this: AudioNode, ...args: never[]) {
        trace.contexts.add(this.context);
        trace.edges.push({ from: this, to: args[0] as unknown as AudioNode | AudioParam });
        return original.apply(this, args);
      },
  );
  patch(
    AudioNode.prototype,
    'disconnect',
    (original) =>
      function (this: AudioNode, ...args: never[]) {
        trace.disconnected.add(this);
        return original.apply(this, args);
      },
  );
  patch(
    AudioParam.prototype,
    'linearRampToValueAtTime',
    (original) =>
      function (this: AudioParam, ...args: never[]) {
        trace.ramps.set(this, args[0] as unknown as number);
        return original.apply(this, args);
      },
  );
  patch(
    AudioBufferSourceNode.prototype,
    'start',
    (original) =>
      function (this: AudioBufferSourceNode, ...args: never[]) {
        trace.started.push(this);
        return original.apply(this, args);
      },
  );
  patch(
    BaseAudioContext.prototype,
    'decodeAudioData',
    (original) =>
      function (this: BaseAudioContext, ...args: never[]) {
        trace.decodes += 1;
        trace.contexts.add(this);
        return original.apply(this, args);
      },
  );
  patch(
    AudioContext.prototype,
    'close',
    (original) =>
      function (this: AudioContext, ...args: never[]) {
        trace.closed.add(this);
        return original.apply(this, args);
      },
  );
  return trace;
}

export interface BusTopology {
  readonly context: BaseAudioContext;
  readonly master: GainNode;
  readonly buses: GainNode[];
}

export function busTopology(trace: AudioGraphTrace): BusTopology | undefined {
  for (const context of trace.contexts) {
    const master = trace
      .inputsOf(context.destination)
      .find((node): node is GainNode => node instanceof GainNode);
    if (master === undefined) continue;
    const buses = trace
      .inputsOf(master)
      .filter((node): node is GainNode => node instanceof GainNode);
    return { context, master, buses };
  }
  return undefined;
}

export function busOfSource(
  trace: AudioGraphTrace,
  topology: BusTopology,
  source: AudioBufferSourceNode,
): { bus: GainNode | undefined; panner: PannerNode | undefined } {
  let node: AudioNode | undefined = source;
  let panner: PannerNode | undefined;
  for (let depth = 0; depth < 4 && node !== undefined; depth += 1) {
    if (topology.buses.includes(node as GainNode)) return { bus: node as GainNode, panner };
    if (node instanceof PannerNode) panner = node;
    node = trace.outputsOf(node).find((next): next is AudioNode => next instanceof AudioNode);
  }
  return { bus: undefined, panner };
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > timeoutMs) return false;
    await sleep(10);
  }
  return true;
}
