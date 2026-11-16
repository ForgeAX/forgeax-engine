import { err, ok } from '@forgeax/engine-types';
import type { OutlineSnapshot } from '../../components/outline';
import { RenderFeaturePreparationFailedError } from '../../errors/render';
import type { FrameReceipt } from '../../render-contract';
import type { RenderFeatureHost } from '../host';
import type {
  RenderFeaturePlanContext,
  RenderFeatureResourceDeclaration,
  RenderFeatureWork,
} from '../plan';
import { captureUnusedSurfaceData } from '../surface-data-usage';
import type { RenderFeature } from '../types';
import {
  freezeSubmittedEditorAssistanceFrame,
  type SubmittedEditorAssistanceFrame,
} from './picking';
import { type EditorAssistanceViewGeometry, projectEditorAssistance } from './projection';
import {
  EDITOR_ASSISTANCE_COPY_SHADER,
  EDITOR_OUTLINE_PROGRAMS,
  editorAssistanceShader,
} from './shaders';
import {
  type EditorAssistanceSourceFrame,
  extractEditorAssistance,
  resolveEditorAssistanceMesh,
} from './source';

export interface EditorAssistanceViewPresentation {
  readonly source: EditorAssistanceSourceFrame;
  readonly geometry: EditorAssistanceViewGeometry;
  readonly authoredOutline?: OutlineSnapshot | undefined;
}
export function editorAssistancePresentation(
  host: RenderFeatureHost | undefined,
): EditorAssistancePresentation | undefined {
  const feature = host?.feature(EDITOR_ASSISTANCE_FEATURE_IDENTITY);
  return feature !== undefined &&
    'editorAssistance' in feature &&
    feature.editorAssistance instanceof EditorAssistancePresentation
    ? feature.editorAssistance
    : undefined;
}
export function captureEditorAssistanceView(
  host: RenderFeatureHost | undefined,
  attempt: number,
  identity: string,
  authoredOutline?: OutlineSnapshot,
): EditorAssistanceViewPresentation | undefined {
  const view = editorAssistancePresentation(host)?.view(attempt, identity);
  if (view === undefined) return undefined;
  const selected = view.source.outline?.entities;
  const entities =
    authoredOutline === undefined || selected === undefined
      ? undefined
      : authoredOutline.entities.filter((entity) => !selected.includes(entity));
  return Object.freeze({
    ...view,
    authoredOutline:
      entities === undefined
        ? authoredOutline
        : entities.length === 0
          ? undefined
          : Object.freeze({
              ...(authoredOutline as OutlineSnapshot),
              entities: Object.freeze(entities),
            }),
  });
}

export const EDITOR_ASSISTANCE_FEATURE_IDENTITY = 'forgeax.editor-assistance';
interface EditorAssistancePlan {
  readonly attempt: number;
  readonly source: EditorAssistanceSourceFrame;
  readonly views: readonly EditorAssistanceViewGeometry[];
}
/** Native readers borrow one planned value; they never re-extract or acquire GPU authority. */
export class EditorAssistancePresentation {
  private planned: EditorAssistancePlan | undefined;
  private submitted: EditorAssistancePlan | undefined;
  private readonly candidates = new WeakMap<EditorAssistanceSourceFrame, EditorAssistancePlan>();
  clear(): void {
    this.planned = this.submitted = undefined;
  }
  stage(
    attempt: number,
    source: EditorAssistanceSourceFrame,
    views: readonly EditorAssistanceViewGeometry[],
  ): void {
    const plan = Object.freeze({ attempt, source, views: Object.freeze([...views]) });
    this.planned = plan;
    this.candidates.set(source, plan);
  }
  view(
    attempt: number,
    identity: string,
  ):
    | {
        readonly source: EditorAssistanceSourceFrame;
        readonly geometry: EditorAssistanceViewGeometry;
      }
    | undefined {
    const planned = this.planned;
    if (planned?.attempt !== attempt) return undefined;
    const geometry = planned.views.find((view) => view.identity === identity);
    return geometry === undefined ? undefined : { source: planned.source, geometry };
  }
  accept(source: EditorAssistanceSourceFrame | undefined): void {
    this.submitted = source === undefined ? undefined : this.candidates.get(source);
  }
  abort(source: EditorAssistanceSourceFrame | undefined): void {
    if (source !== undefined) this.candidates.delete(source);
    if (this.planned?.source === source) this.planned = undefined;
  }
  bindReceipt(
    attempt: number,
    receipt: Pick<FrameReceipt, 'frameId' | 'deviceGeneration'>,
  ): SubmittedEditorAssistanceFrame | undefined {
    const submitted = this.submitted;
    if (submitted?.attempt !== attempt) return undefined;
    this.submitted = undefined;
    return freezeSubmittedEditorAssistanceFrame({
      frameId: receipt.frameId,
      deviceGeneration: receipt.deviceGeneration,
      sourceIdentity: submitted.source.sourceIdentity,
      sourceMutationEpoch: submitted.source.sourceMutationEpoch,
      revision: submitted.source.revision,
      views: Object.freeze(
        submitted.views.map(({ identity, width, height, hits }) =>
          Object.freeze({ identity, width, height, hits }),
        ),
      ),
    });
  }
}
export interface EditorAssistanceRenderFeature
  extends RenderFeature<EditorAssistanceSourceFrame | undefined> {
  readonly editorAssistance: EditorAssistancePresentation;
}
function sourceFailure(name: string, reason: string) {
  return err(
    new RenderFeaturePreparationFailedError(
      EDITOR_ASSISTANCE_FEATURE_IDENTITY,
      0,
      'source-asset',
      'vertex-data',
      name,
      reason,
      'next-frame',
    ),
  );
}
/** One installed source/plan owner; idle extraction has no data, passes or GPU declarations. */
export function createEditorAssistanceFeature(): EditorAssistanceRenderFeature {
  const presentation = new EditorAssistancePresentation();
  return Object.freeze(
    captureUnusedSurfaceData<EditorAssistanceRenderFeature>({
      identity: EDITOR_ASSISTANCE_FEATURE_IDENTITY,
      inactiveSourceData: undefined,
      editorAssistance: presentation,
      extract: (context) => ok(extractEditorAssistance(context)),
      assetDependencies: (data) => data?.meshes.map((mesh) => mesh.handle) ?? [],
      requiresPreparation: (data) => data !== undefined,
      plan: (data: EditorAssistanceSourceFrame | undefined, context: RenderFeaturePlanContext) => {
        if (data === undefined) {
          presentation.clear();
          return ok({ work: [] });
        }
        for (const mesh of data.meshes) {
          if (mesh.revision === undefined)
            return sourceFailure(String(mesh.handle), 'missing-version');
          const asset = resolveEditorAssistanceMesh(mesh, context);
          if (asset === undefined) return sourceFailure(String(mesh.handle), 'unavailable-mesh');
          const position = asset.attributes.position;
          if (!(position instanceof Float32Array) && !(position instanceof ArrayBuffer))
            return sourceFailure(String(mesh.handle), 'unsupported-position-format');
        }
        const work: RenderFeatureWork[] = [],
          projected: EditorAssistanceViewGeometry[] = [];
        for (const view of context.views) {
          if (
            data.camera !== undefined &&
            view.identity !== `camera:${data.camera}` &&
            !view.identity.startsWith(`camera:${data.camera}:`)
          )
            continue;
          const geometry = projectEditorAssistance(data, view, context);
          if (geometry === undefined) continue;
          projected.push(geometry);
          const depthSamples =
            view.targets.find((target) => target.name === 'depth')?.sampleCount ?? 1;
          work.push(viewWork(view.identity, geometry, depthSamples, data.outline !== undefined));
        }
        presentation.stage(context.frame.frameNumber, data, projected);
        return ok({ work });
      },
      onFrameSubmitted: (data) => presentation.accept(data),
      onFrameAborted: (data) => presentation.abort(data),
    }),
  );
}
function viewWork(
  identity: string,
  geometry: EditorAssistanceViewGeometry,
  depthSamples: 1 | 4,
  outline: boolean,
): RenderFeatureWork {
  const resources: RenderFeatureResourceDeclaration[] = [
    {
      kind: 'fullscreen-program',
      name: 'editor-copy',
      source: EDITOR_ASSISTANCE_COPY_SHADER,
      reads: ['editor-input'],
    },
    {
      kind: 'graphics-program',
      name: 'editor-copy-pipeline',
      program: {
        shader: 'editor-copy',
        vertexLayout: 'none',
        colorFormats: ['rgba16float'],
        sampleCount: 1,
      },
    },
    {
      kind: 'graphics-bindings',
      name: 'editor-copy-bindings',
      program: 'editor-copy-pipeline',
      values: { group: 1, fullscreen: true, shader: 'editor-copy', input: 'editor-input' },
      logicalTargets: { input: 'editor-input' },
    },
  ];
  if (outline) resources.push(...EDITOR_OUTLINE_PROGRAMS);
  const passes: RenderFeatureWork['passes'][number][] = [
    {
      kind: 'raster',
      name: 'editor-copy',
      colorAttachments: [{ target: 'editor-output', loadOp: 'clear', storeOp: 'store' }],
      sampledTargets: ['editor-input'],
      draws: [
        {
          program: 'editor-copy-pipeline',
          bindings: ['editor-copy-bindings'],
          vertexData: [],
          vertexLayout: 'none',
          draw: { kind: 'draw', vertexCount: 3, instanceCount: 1 },
        },
      ],
    },
  ];
  for (const depth of ['occluded', 'always'] as const) {
    const vertices = geometry[depth];
    if (vertices.length === 0) continue;
    const name = `editor-${depth}`;
    resources.push(
      {
        kind: 'fullscreen-program',
        name,
        source: editorAssistanceShader(depth, depthSamples),
        vertexLayout: 'clip-position-color',
        ...(depth === 'always' ? {} : { depthSampleCount: depthSamples }),
        reads: [
          'editor-input',
          ...(depth === 'always' ? [] : [{ key: 'editor-depth', sampleType: 'depth' as const }]),
        ],
      },
      {
        kind: 'graphics-program',
        name: `${name}-pipeline`,
        program: {
          shader: name,
          vertexLayout: 'clip-position-color',
          colorFormats: ['rgba16float'],
          sampleCount: 1,
        },
      },
      {
        kind: 'graphics-bindings',
        name: `${name}-bindings`,
        program: `${name}-pipeline`,
        values: {
          group: 1,
          fullscreen: true,
          shader: name,
          input: 'editor-input',
          ...(depth === 'always' ? {} : { depth: 'editor-depth' }),
        },
        logicalTargets: {
          input: 'editor-input',
          ...(depth === 'always' ? {} : { depth: 'editor-depth' }),
        },
      },
      {
        kind: 'buffer',
        name: `${name}-buffer`,
        size: 2 ** Math.ceil(Math.log2(Math.max(32, vertices.byteLength))),
        usage: ['vertex'],
        data: vertices,
      },
      {
        kind: 'vertex-data',
        name: `${name}-vertices`,
        layout: 'clip-position-color',
        buffer: `${name}-buffer`,
        size: vertices.byteLength,
      },
    );
    passes.push({
      kind: 'raster',
      name,
      colorAttachments: [{ target: 'editor-output', loadOp: 'load', storeOp: 'store' }],
      sampledTargets: ['editor-input', ...(depth === 'always' ? [] : ['editor-depth'])],
      draws: [
        {
          program: `${name}-pipeline`,
          bindings: [`${name}-bindings`],
          vertexData: [{ slot: 0, resource: `${name}-vertices` }],
          draw: { kind: 'draw', vertexCount: vertices.length / 8, instanceCount: 1 },
        },
      ],
    });
  }
  return { scope: { view: identity }, resources, passes };
}
