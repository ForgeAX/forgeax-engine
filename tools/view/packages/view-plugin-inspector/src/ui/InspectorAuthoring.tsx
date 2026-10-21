import { normalizeParameterValue } from '@forgeax/engine-pack/source';
import { Button, Toolbar } from '@forgeax/view-components';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import type { WorkspaceEntityInspection, WorkspaceProject, WorkspaceTarget } from '@forgeax/view-workspace-core/contract';
import { createPackAuthoringClient, packParameterReference, type PackDraftField } from '@forgeax/view-workspace-core/pack-authoring';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { InspectorField } from '../inspection';

type Author = ReturnType<typeof createPackAuthoringClient>;

/** One subscription to the Engine document shared with the Pack parameter panel. */
export function useInspectorAuthoring(input: {
  client?: ViewWorkspaceClient;
  inspection?: WorkspaceEntityInspection;
  project?: WorkspaceProject | null;
  target?: WorkspaceTarget | null;
  projectId?: string;
  sessionId?: string;
  targetId?: string;
  addConversationReference?: (reference: { title: string; text: string }) => Promise<void>;
}) {
  const { client, projectId, sessionId, targetId } = input;
  const source = input.inspection?.source;
  const [author, setAuthor] = useState<Author>();
  const [state, setState] = useState<ReturnType<Author['getSnapshot']>>({ pending: false, closed: false });
  const [error, setError] = useState('');
  const frame = useRef<number | undefined>(undefined);
  const sourcePath = source?.sourcePath;
  useEffect(() => {
    setState({ pending: false, closed: false }); setError('');
    if (!client || !sourcePath || !projectId || !sessionId || !targetId) { setAuthor(undefined); return; }
    const current = createPackAuthoringClient(client, { sourcePath, projectId, sessionId, targetId, previewTargetId: () => targetId });
    setAuthor(current);
    let disposed = false;
    const unsubscribe = current.subscribe(() => {
      const next = current.getSnapshot();
      setState(next);
      if (next.draft) setError('');
    });
    void current.open().catch(cause => { if (!disposed) setError(String(cause?.hint ?? cause)); });
    return () => {
      disposed = true; unsubscribe(); current.dispose();
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      frame.current = undefined;
    };
  }, [client, sourcePath, projectId, sessionId, targetId]);
  const fields = useMemo(() => new Map(state.draft?.fields.flatMap(field => typeof field.apply === 'object'
    ? [[JSON.stringify([field.apply.asset, field.apply.path]), field] as const] : [])), [state.draft?.fields]);
  const act = (action: 'save' | 'undo' | 'redo') => {
    setError(''); void author?.act(action).catch(cause => setError(String(cause?.hint ?? cause)));
  };
  const edit = (name: string, value: unknown) => {
    author?.edit(name, value);
    if (frame.current === undefined) frame.current = requestAnimationFrame(() => {
      frame.current = undefined;
      void author?.flush().catch(cause => setError(String(cause?.hint ?? cause)));
    });
  };
  return {
    toolbar: source ? <div className="insp-authoring" aria-label="Source draft">
      {state.draft ? <Toolbar><span>{state.draft.unsaved || state.pending ? 'Unsaved source changes' : 'Source saved'}</span>
        <Button size="compact" disabled={(!state.draft.unsaved && !state.pending) || state.draft.conflicts.length > 0} onClick={() => act('save')}>Save</Button>
        <Button size="compact" disabled={!state.draft.canUndo} onClick={() => act('undo')}>Undo</Button>
        <Button size="compact" disabled={!state.draft.canRedo} onClick={() => act('redo')}>Redo</Button>
      </Toolbar> : null}
      {error || state.draft?.error ? <span role="alert">{error || state.draft?.error?.hint}</span> : null}
    </div> : null,
    renderField(component: string, field: InspectorField, fallback: ReactNode): ReactNode {
      if (!source) return fallback;
      const address = typeof source.address === 'string' ? source.address : source.address.length === 1 ? source.address[0] : undefined;
      const path = address === undefined
        ? source.fieldPaths?.find(entry => entry.component === component && entry.field === field.key)?.path
        : ['entities', address, 'components', component, field.key];
      const binding = path === undefined ? undefined : fields.get(JSON.stringify([source.sourceKey, path]));
      if (binding && state.draft) return <AuthorField field={binding} value={state.draft.values[binding.name]} onChange={value => edit(binding.name, value)} />;
      if (!input.addConversationReference || !source.sourcePath.endsWith('.pack.ts') || field.rawValue === undefined || ['Entity', 'ChildOf', 'Children', 'SceneInstance', 'GlobalTransform'].includes(component)) return fallback;
      return <span className="insp-author-field">{fallback}<button type="button" className="insp-author-expose" title="Expose as a Pack parameter with Agent" aria-label={`Expose ${component}.${field.key} with Agent`} onClick={() => {
        void input.addConversationReference!(packParameterReference({
          sourcePath: source.sourcePath, project: input.project, target: input.target, draft: state.draft, error,
          field: { component, key: field.key, value: field.rawValue,
            schema: input.inspection?.components.find(value => value.name === component)?.fields?.[field.key],
            asset: source.sourceKey, address: source.address, path },
        })).catch(cause => setError(String(cause)));
      }}>Expose</button></span>;
    },
  };
}

function AuthorField({ field, value, onChange }: { field: PackDraftField; value: unknown; onChange(value: unknown): void }) {
  const [text, setText] = useState(JSON.stringify(value));
  const [invalid, setInvalid] = useState(false);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) { setText(JSON.stringify(value)); setInvalid(false); } }, [value]);
  return <input className="insp-author-input" aria-label={`Runtime ${field.name}`} aria-invalid={invalid} value={text} onFocus={() => { focused.current = true; }} onBlur={() => { focused.current = false; }} onChange={event => {
    setText(event.target.value);
    try {
      const checked = normalizeParameterValue(field, JSON.parse(event.target.value), field.name);
      setInvalid(!checked.ok); if (checked.ok) onChange(checked.value);
    } catch { setInvalid(true); }
  }} />;
}
