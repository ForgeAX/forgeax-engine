import type {
  GraphAccess,
  GraphBuffer,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import { ok, type Result } from '@forgeax/engine-types';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { PreparedIrradianceField } from './renderer-irradiance-field';

type Stage = keyof PreparedIrradianceField['kernels'];
/** The field's existing kernel recorder owns both graph accesses and encoding. */
export type FieldKernelPass = (
  label: string,
  stage: Stage,
  work: (value: PreparedIrradianceField) => number,
  before?: (value: PreparedIrradianceField) => void,
  after?: readonly Stage[],
  executeIf?: () => boolean,
) => Result<unknown, RenderGraphError>;

/** One feedback sequence: prior Card bounce -> World probe update -> current
 * Card probes and reconstruction. The legacy feedback-off branch stays here so
 * the caller cannot reorder its submit-time frame upload or resource accesses. */
export function addCardRadiosityGraph(input: {
  readonly graph: RenderGraphBuilder<RenderPipelineFrame>;
  readonly prepared: PreparedIrradianceField;
  readonly current: () => PreparedIrradianceField;
  readonly kernelPass: FieldKernelPass;
  readonly frameUniform: GraphBuffer;
  readonly surfaces: GraphBuffer;
  readonly cardDirect: GraphBuffer;
  readonly cardLit: GraphBuffer;
  readonly tileThreads: () => number;
  readonly fieldReads: () => readonly GraphAccess[];
}): Result<void, RenderGraphError> {
  const {
    graph,
    prepared,
    current,
    kernelPass,
    frameUniform,
    surfaces,
    cardDirect,
    cardLit,
    tileThreads,
  } = input;
  const radiosity = prepared.cardRadiosity;
  const allCardThreads = (value: PreparedIrradianceField) =>
    value.tileCount * value.plan.cardResolution ** 2;
  const cardProbeThreads = (value: PreparedIrradianceField) =>
    (value.cardRadiosity?.update().tiles.length ?? 0) *
    (value.cardRadiosity?.plan.probesPerCard ?? 0);
  if (radiosity !== undefined) {
    const bounce = kernelPass(
      'card-radiosity-bounce',
      'prepareCardRadiosityBounce',
      allCardThreads,
    );
    if (!bounce.ok) return bounce;
  }
  const placed = kernelPass('place-probes', 'placeProbes', (value) => value.schedule().probes);
  if (!placed.ok) return placed;
  const probesTraced = kernelPass(
    'trace-probes',
    'traceProbes',
    (value) => value.schedule().probes * value.plan.raysPerProbe,
    (value) => value.writeFrame(),
  );
  if (!probesTraced.ok) return probesTraced;
  // The derive kernel's bindings are a subset of the update kernel's accesses.
  const updated = kernelPass(
    'update-probes',
    'updateProbes',
    (value) => value.schedule().probes,
    undefined,
    ['deriveProbes'],
  );
  if (!updated.ok) return updated;
  const fieldReads = input.fieldReads();
  if (radiosity !== undefined) {
    for (const stage of [
      'placeCardRadiosity',
      'traceCardRadiosity',
      'visibilityCardRadiosity',
      'filterCardRadiosity',
      'integrateCardRadiosity',
    ] as const) {
      const perRay = stage === 'traceCardRadiosity' || stage === 'filterCardRadiosity';
      const pass = kernelPass(
        stage,
        stage,
        (value) =>
          stage === 'visibilityCardRadiosity'
            ? (value.cardRadiosity?.update().tiles.length ?? 0) * value.plan.cardResolution ** 2
            : cardProbeThreads(value) * (perRay ? radiosity.plan.raysPerProbe : 1),
        undefined,
        [],
        () =>
          cardProbeThreads(current()) > 0 &&
          (stage !== 'visibilityCardRadiosity' ||
            (current().capture() === undefined && !current().pendingMaterialCapture())),
      );
      if (!pass.ok) return pass;
    }
    const resolved = kernelPass('radiosity', 'resolveCardRadiosity', allCardThreads);
    if (!resolved.ok) return resolved;
  } else {
    const radiated = graph.addComputePass('irradiance-field.radiosity', {
      accesses: [
        { resource: frameUniform, usage: 'uniform-read' },
        { resource: surfaces, usage: 'storage-read' },
        { resource: cardDirect, usage: 'storage-read' },
        { resource: cardLit, usage: 'storage-write' },
        ...fieldReads,
      ],
      encodeDirect: (pass, _graphframe, resources) => {
        const value = current();
        value.view.radiateCards
          .record(
            pass,
            [frameUniform, surfaces, cardDirect, cardLit].map((r) => ({
              buffer: resources.buffer(r).unwrap(),
            })),
            value.sample,
            tileThreads(),
          )
          .unwrap();
      },
    });
    if (!radiated.ok) return radiated;
  }
  return ok(undefined);
}
