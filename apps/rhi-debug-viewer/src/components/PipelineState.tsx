import { resolveTextureResource } from '../draw-call-resources';
import { useOpenViewerPanel } from '../panel-navigation';
import { useSelection } from '../selection-context';
import { pipelineStateAnchor } from '../selectors';
import type { ShaderPreviewSelection, ShaderPreviewWorkFacts } from '../shader-preview/session';
import { useViewModel } from '../viewer-context';
import type { ViewerModel, WorkPipeline } from '../viewer-model';
import { CodeMirrorShader } from './CodeMirrorShader';

export const ALL_SECTIONS = [
  'inputAssembly',
  'vertexInput',
  'shaders',
  'rasterizer',
  'depthStencil',
  'blend',
  'multisample',
  'resourceBindings',
] as const;

export type SectionId = (typeof ALL_SECTIONS)[number];

export const SECTION_LABELS: Record<SectionId, string> = {
  inputAssembly: 'Input Assembly',
  vertexInput: 'Vertex Input',
  shaders: 'Shaders',
  rasterizer: 'Rasterizer',
  depthStencil: 'Depth-Stencil',
  blend: 'Blend',
  multisample: 'Multisample',
  resourceBindings: 'Resource Bindings',
};

function modelDigest(model: ViewerModel): string {
  let hash = 2166136261;
  for (const character of JSON.stringify(model)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16)}`;
}

export function selectedShaderPreview(
  model: ViewerModel,
  workIndex: number,
  stage: WorkPipeline['shaders'][number]['stage'],
): ShaderPreviewSelection | null {
  const work = model.works.find((candidate) => candidate.workIndex === workIndex);
  const shader = work?.pipeline.shaders.find((candidate) => candidate.stage === stage);
  if (work === undefined || shader === undefined) return null;
  const stages = Object.fromEntries(
    work.pipeline.shaders
      .filter(
        (candidate) =>
          (candidate.stage === 'vertex' || candidate.stage === 'fragment') &&
          candidate.source !== null,
      )
      .map((candidate) => [
        candidate.stage,
        { source: candidate.source as string, entryPoint: candidate.entryPoint },
      ]),
  ) as NonNullable<ShaderPreviewSelection['stages']>;
  const baseSelection: ShaderPreviewSelection = {
    tapeDigest: modelDigest(model),
    workIndex,
    stage: shader.stage,
    shaderModuleId: shader.moduleHandleId,
    entryPoint: shader.entryPoint,
    source: shader.source ?? '',
    pipelineKind: work.pipeline.kind ?? 'compute',
    work: {
      drawCall: work.drawCall,
      pipeline: work.pipeline,
      bindings: work.bindings,
      vertexBuffers: work.vertexBuffers,
      indexBuffer: work.indexBuffer,
      attachments: work.attachments,
    } satisfies ShaderPreviewWorkFacts,
  };
  return Object.keys(stages).length === 0 ? baseSelection : { ...baseSelection, stages };
}

export function PipelineState(_props?: { readonly className?: string }) {
  const model = useViewModel();
  const openPanel = useOpenViewerPanel();
  const { selectedWorkIndex, selectResource } = useSelection();
  const works = model?.works ?? [];
  const work = works.find((candidate) => candidate.workIndex === selectedWorkIndex);
  const selected = work !== undefined;
  const openResource = (resourceId: string) => {
    if (model === null) return;
    const texture = resolveTextureResource(model, resourceId);
    if (texture !== undefined) {
      selectResource(texture.resourceId);
      openPanel('draw-call-viewer');
      return;
    }
    selectResource(resourceId);
    openPanel('resource-inspector');
  };

  return (
    <section
      className="forgeax-panel flex flex-col overflow-auto"
      {...{ [pipelineStateAnchor()]: selected ? 'selected' : 'default' }}
    >
      {!selected || model === null ? (
        <EmptyState
          title="No work selected"
          description="Select a work item to inspect its pipeline"
        />
      ) : (
        <div className="space-y-fx-12 p-fx-12 text-compact">
          <div className="text-caption text-muted-foreground">Work {work.workIndex}</div>
          <div className="grid grid-cols-2 gap-x-fx-12 gap-y-fx-4 border-b border-border pb-fx-12">
            <span className="text-muted-foreground">workIndex</span>
            <span data-forgeax-work-index={String(work.workIndex)}>{work.workIndex}</span>
            <span className="text-muted-foreground">eventIndex</span>
            <span>{work.eventIndex}</span>
            <span className="text-muted-foreground">passIndex</span>
            <span>{work.passIndex}</span>
            <span className="text-muted-foreground">method</span>
            <span className="font-mono">{work.kind}</span>
          </div>
          <div className="grid grid-cols-2 gap-fx-6">
            {ALL_SECTIONS.map((section) => (
              <div key={section} className="border-b border-border p-fx-8">
                <div className="text-caption font-medium text-foreground">
                  {SECTION_LABELS[section]}
                </div>
                <div className="mt-fx-4 break-all text-muted-foreground">
                  {section === 'shaders'
                    ? work.pipeline.shaders
                        .map((shader) => `${shader.stage}:${shader.entryPoint ?? '-'}`)
                        .join(', ') || 'none'
                    : section === 'resourceBindings'
                      ? work.bindings.length === 0
                        ? 'none'
                        : `${work.bindings.length} bindings · ${work.bindings.map((binding) => binding.resourceKind ?? 'unknown').join(', ')}`
                      : section === 'vertexInput'
                        ? `${work.vertexBuffers.length} vertex buffers${work.indexBuffer === null ? '' : `, index ${work.indexBuffer.format}`}`
                        : section === 'inputAssembly'
                          ? JSON.stringify(work.drawCall)
                          : section === 'rasterizer'
                            ? (work.pipeline.kind ?? 'unavailable')
                            : section === 'depthStencil'
                              ? (work.attachments?.depthStencilViewHandleId ?? 'none')
                              : 'captured'}
                </div>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-x-fx-12 gap-y-fx-8 border-t border-border pt-fx-12">
            <span className="text-muted-foreground">pipeline</span>
            {work.pipeline.pipelineHandleId === undefined ? (
              <span className="font-mono">{work.pipeline.status}</span>
            ) : (
              <button
                type="button"
                className="forgeax-resource-link"
                aria-label={`Open ${work.pipeline.pipelineHandleId} in Resource Inspector`}
                title="Open Resource Inspector"
                onClick={() => openResource(work.pipeline.pipelineHandleId as string)}
              >
                {work.pipeline.pipelineHandleId}
              </button>
            )}
            <span className="text-muted-foreground">pipeline descriptor</span>
            <pre className="forgeax-code-block min-w-0" data-forgeax-pipeline-descriptor>
              {work.pipeline.descriptor === undefined
                ? (work.pipeline.reason ?? 'unavailable')
                : JSON.stringify(work.pipeline.descriptor, null, 2)}
            </pre>
            {work.pipeline.shaders.map((shader) => {
              const selection = selectedShaderPreview(model, work.workIndex, shader.stage);
              return (
                <div key={shader.stage} className="col-span-2 border-t border-border py-fx-8">
                  <span className="font-mono">
                    {shader.stage} {shader.moduleHandleId} {shader.entryPoint ?? '-'}
                  </span>
                  {selection === null ? (
                    <p className="text-muted-foreground">Shader facts unavailable.</p>
                  ) : (
                    <CodeMirrorShader selection={selection} />
                  )}
                </div>
              );
            })}
            {work.bindings.map((binding) => {
              const resourceId = binding.resourceId;
              const texture =
                resourceId === null ? undefined : resolveTextureResource(model, resourceId);
              const panel = texture === undefined ? 'Resource Inspector' : 'Draw Call Viewer';
              return (
                <button
                  type="button"
                  key={`${binding.groupIndex}:${binding.binding}`}
                  className="forgeax-resource-link col-span-2"
                  aria-label={`Open ${resourceId ?? 'unavailable resource'} in ${panel}`}
                  title={`Open ${panel}`}
                  disabled={resourceId === null}
                  onClick={() => {
                    if (resourceId !== null) openResource(resourceId);
                  }}
                >
                  group {binding.groupIndex} · binding {binding.binding} ·{' '}
                  {binding.resourceKind ?? 'unknown'} · {binding.bindGroupId} ·{' '}
                  {resourceId ?? 'no resource'}
                </button>
              );
            })}
            {work.vertexBuffers.map((buffer) => (
              <button
                type="button"
                key={buffer.slot}
                className="forgeax-resource-link col-span-2"
                aria-label={`Open ${buffer.bufferHandleId} in Resource Inspector`}
                title="Open Resource Inspector"
                onClick={() => openResource(buffer.bufferHandleId)}
              >
                vertex slot {buffer.slot} {buffer.bufferHandleId} offset {buffer.offset} size{' '}
                {buffer.size ?? 'all'}
              </button>
            ))}
            {work.indexBuffer !== null && (
              <button
                type="button"
                className="forgeax-resource-link col-span-2"
                aria-label={`Open ${work.indexBuffer.bufferHandleId} in Resource Inspector`}
                title="Open Resource Inspector"
                onClick={() => openResource(work.indexBuffer?.bufferHandleId as string)}
              >
                index {work.indexBuffer.bufferHandleId} {work.indexBuffer.format} offset{' '}
                {work.indexBuffer.offset} size {work.indexBuffer.size ?? 'all'}
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

import { EmptyState } from '@forgeax/view-components';
