import type { ReplayReadbackResult, RhiDebugError } from '@forgeax/engine-rhi-debug';
import { EmptyState, SearchField } from '@forgeax/view-components';
import { useEffect, useMemo, useState } from 'react';
import { bufferRange, formatBufferHex, formatBufferTyped } from '../buffer-view';
import { useSelection } from '../selection-context';
import { resourceInspectorAnchor, resourceRowAnchor } from '../selectors';
import { useReadResource, useViewModel } from '../viewer-context';

export function ResourceInspector(_props?: { readonly className?: string }) {
  const model = useViewModel();
  const readResource = useReadResource();
  const { selectedWorkIndex, selectedResourceId, selectResource, selectWork } = useSelection();
  const [filter, setFilter] = useState('');
  const [readback, setReadback] = useState<ReplayReadbackResult | null>(null);
  const [readbackError, setReadbackError] = useState<RhiDebugError | null>(null);
  const resources = useMemo(() => {
    const all = model?.resources ?? [];
    const needle = filter.trim().toLowerCase();
    return needle.length === 0
      ? all
      : all.filter((resource) => resource.resourceId.toLowerCase().includes(needle));
  }, [filter, model]);
  const focusedResource =
    resources.find((resource) => resource.resourceId === selectedResourceId) ??
    (selectedWorkIndex >= 0
      ? resources.find((resource) =>
          resource.consumers.some((consumer) => consumer.workIndex === selectedWorkIndex),
        )
      : undefined);
  const selectedResource =
    selectedResourceId === null
      ? undefined
      : model?.resources.find((resource) => resource.resourceId === selectedResourceId);
  const readsBytes = selectedResource?.kind === 'buffer';
  const selected = selectedWorkIndex >= 0 || selectedResourceId !== null;

  const inspectResource = (resourceId: string) => {
    const resource = model
      ? model.resources.find((item) => item.resourceId === resourceId)
      : undefined;
    const consumer = resource?.consumers.find((item) => item.workIndex !== null);
    if (consumer?.workIndex !== null && consumer?.workIndex !== undefined)
      selectWork(consumer.workIndex, consumer.eventIndex, resource?.createEventIndex ?? -1);
    selectResource(resourceId);
  };

  useEffect(() => {
    setReadback(null);
    setReadbackError(null);
    if (selectedResourceId === null || readResource === null || !readsBytes) return;
    const request = new AbortController();
    void readResource(selectedResourceId, undefined, request.signal).then((result) => {
      if (request.signal.aborted) return;
      if (result.ok) setReadback(result.value);
      else setReadbackError(result.error);
    });
    return () => request.abort();
  }, [readResource, readsBytes, selectedResourceId]);

  return (
    <section
      className="forgeax-panel flex flex-col overflow-auto"
      {...{ [resourceInspectorAnchor()]: selected ? 'selected' : 'empty' }}
    >
      <div className="forgeax-panel-toolbar gap-fx-8">
        <SearchField
          className="flex-1"
          label="Filter resource IDs"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onClear={() => setFilter('')}
          placeholder="texture:, buffer:, pipeline:..."
        />
        <span className="shrink-0 text-caption text-muted-foreground">
          {resources.length} shown
        </span>
      </div>
      <div className="flex flex-1 flex-col overflow-auto p-fx-12">
        <div className="flex flex-1 flex-col space-y-fx-4 pr-fx-4">
          {resources.length === 0 ? (
            <EmptyState
              title={filter ? 'No matching resources' : 'No resources in tape'}
              description={filter ? 'Try another resource ID' : ''}
            />
          ) : (
            resources.map((resource) => (
              <button
                type="button"
                key={resource.resourceId}
                className={
                  selectedResourceId === resource.resourceId
                    ? 'w-full rounded bg-muted px-fx-8 py-fx-6 text-left text-compact text-foreground'
                    : 'w-full rounded px-fx-8 py-fx-6 text-left text-compact transition-colors hover:bg-muted'
                }
                onClick={() => inspectResource(resource.resourceId)}
                {...{ [resourceRowAnchor()]: resource.resourceId }}
              >
                <span className="font-mono">{resource.resourceId}</span>
                <span className="ml-fx-8 text-muted-foreground">{resource.kind}</span>
              </button>
            ))
          )}
        </div>
        {selected && (
          <p className="pt-fx-12 text-caption text-muted-foreground">
            Linked from workIndex {selectedWorkIndex}
          </p>
        )}
        {focusedResource !== undefined && (
          <div className="mt-fx-12 space-y-fx-4 border-t border-border pt-fx-12 text-compact">
            <div className="text-caption font-medium text-foreground">Resource facts</div>
            <pre className="forgeax-code-block">
              {JSON.stringify(focusedResource.descriptor, null, 2)}
            </pre>
            <div>lifecycle {focusedResource.lifecycle.state}</div>
            <div>consumers {focusedResource.consumers.length}</div>
            {focusedResource.consumers.map((consumer) => (
              <div key={`${consumer.eventIndex}:${consumer.access}`} className="font-mono">
                eventIndex {consumer.eventIndex} workIndex {consumer.workIndex ?? 'none'}{' '}
                {consumer.access}
              </div>
            ))}
          </div>
        )}
        {readsBytes && selectedResourceId !== null && readback !== null && (
          <div className="mt-fx-12 border-t border-border pt-fx-12 text-compact">
            <div className="text-success">Readback {selectedResourceId}</div>
            {readback.kind === 'texture' ? (
              <div className="font-mono">
                {readback.format ?? 'texture'} {readback.width ?? 0}x{readback.height ?? 0}
                <div data-forgeax-resource-provenance>
                  {readback.provenance.resourceId} {JSON.stringify(readback.provenance.subresource)}
                </div>
              </div>
            ) : (
              <BufferResult result={readback} />
            )}
          </div>
        )}
        {readsBytes && selectedResourceId !== null && readbackError !== null && (
          <div className="mt-fx-12 border-t border-border pt-fx-12 text-compact text-danger">
            <div data-forgeax-buffer-status={readbackError.code}>{readbackError.code}</div>
            <div>{readbackError.code}</div>
            <div>{readbackError.hint}</div>
          </div>
        )}
        {readsBytes &&
          selectedResourceId !== null &&
          readback === null &&
          readbackError === null && (
            <div
              className="mt-fx-12 text-caption text-muted-foreground"
              data-forgeax-buffer-status="pending"
            >
              Readback pending
            </div>
          )}
      </div>
    </section>
  );
}

function BufferResult({ result }: { readonly result: ReplayReadbackResult }) {
  const range = bufferRange(result);
  return (
    <div className="space-y-fx-4 font-mono" data-forgeax-buffer-status="ok">
      <div>offset {range.offset}</div>
      <div>size {range.size}</div>
      <div>hex {formatBufferHex(result.bytes)}</div>
      <div>{formatBufferTyped(result.bytes)}</div>
    </div>
  );
}
