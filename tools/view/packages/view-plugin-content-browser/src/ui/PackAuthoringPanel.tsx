import { normalizeParameterValue } from '@forgeax/engine-pack/source';
import { createPackAuthoringClient, packParameterReference, type PackDraftField } from '@forgeax/view-workspace-core/pack-authoring';
import { Button, CollapsibleSection, ColorPicker, Dialog, Field, formatInspectorFieldLabel, IconButton, PropertyRow, Select, Status, Switch, TextInput, Toolbar, Tooltip } from '@forgeax/view-components';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import { createWorkspaceStateReader } from '@forgeax/view-workspace-core/workspace-state';
import { Redo2, RefreshCw, Save, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from '../i18n/useTranslation';
import './pack-authoring.css';

function display(value: unknown): string { return typeof value === 'string' ? value : JSON.stringify(value) ?? ''; }
function fieldLabel(field: PackDraftField): string {
  return field.name.startsWith('[')
    ? field.path.slice(3).map(formatInspectorFieldLabel).join('.')
    : formatInspectorFieldLabel(field.name);
}
function message(error: unknown): string {
  if (error && typeof error === 'object' && 'detail' in error && error.detail && typeof error.detail === 'object' && 'reason' in error.detail) return String(error.detail.reason);
  if (error && typeof error === 'object' && 'hint' in error) return String(error.hint);
  return error instanceof Error ? error.message : String(error);
}
/** Controls submit intent to the Engine draft. They retain only text that is not yet valid input. */
export function PackAuthoringPanel({ client, sourcePath, addConversationReference }: {
  client: ViewWorkspaceClient;
  sourcePath: string;
  addConversationReference?: (reference: { title: string; text: string }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const reader = useMemo(() => createWorkspaceStateReader(client), [client]);
  const workspace = useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot);
  const projectId = workspace?.project?.id;
  const [error, setError] = useState('');
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [closeChoice, setCloseChoice] = useState(false);
  const frame = useRef<number | undefined>(undefined);
  const previews = workspace?.previews ?? [];
  const [selectedTarget, selectTarget] = useState<string>();
  const matchingPreviews = previews.filter(preview => {
    const path = preview.asset?.sourcePath ?? preview.asset?.path;
    return path === sourcePath || (path && workspace?.project?.root && path === `${workspace.project.root}/${sourcePath}`);
  });
  const previewTargetId = selectedTarget && matchingPreviews.some(p => p.target?.targetId === selectedTarget) ? selectedTarget : matchingPreviews.length === 1 ? matchingPreviews[0]?.target?.targetId : undefined;
  const previewRef = useRef(previewTargetId);
  previewRef.current = previewTargetId;

  const sessionId = workspace?.projectTarget?.sessionId;
  const targetId = workspace?.projectTarget?.targetId;
  const [author, setAuthor] = useState<ReturnType<typeof createPackAuthoringClient>>();
  const [presentation, setPresentation] = useState<ReturnType<ReturnType<typeof createPackAuthoringClient>['getSnapshot']>>({ pending: false, closed: false });
  const { draft, pending, closed } = presentation;
  useEffect(() => {
    setPresentation({ pending: false, closed: false }); setError('');
    if (!projectId || !sessionId || !targetId) { setAuthor(undefined); return; }
    const current = createPackAuthoringClient(client, { projectId, sessionId, targetId, sourcePath, previewTargetId: () => previewRef.current });
    setAuthor(current);
    let disposed = false;
    const unsubscribe = current.subscribe(() => {
      const next = current.getSnapshot();
      setPresentation(next);
      if (next.draft) setError('');
    });
    void current.open().catch(cause => { if (!disposed) setError(message(cause)); });
    return () => {
      disposed = true; unsubscribe(); current.dispose();
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      frame.current = undefined;
    };
  }, [client, projectId, sessionId, targetId, sourcePath]);

  useEffect(() => {
    if (!draft?.unsaved && !pending) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [draft?.unsaved, pending]);

  const act = async (action: Parameters<NonNullable<typeof author>['act']>[0], discard = false) => {
    if (!author) return false;
    setError('');
    if (action === 'generate') setGenerating(true);
    if (action === 'save') setSaving(true);
    try { await author.act(action, discard); return true; }
    catch (cause) { setError(message(cause)); return false; }
    finally { setGenerating(false); setSaving(false); }
  };
  const edit = (field: string, value: unknown) => {
    author?.edit(field, value);
    if (frame.current === undefined) frame.current = requestAnimationFrame(() => {
      frame.current = undefined;
      void author?.flush().catch(cause => setError(message(cause)));
    });
  };

  const addParameter = addConversationReference && sourcePath.endsWith('.pack.ts') ? <Button size="compact" onClick={() => void addConversationReference(packParameterReference({
    sourcePath, project: workspace?.project,
    target: matchingPreviews.find(preview => preview.target.targetId === previewTargetId)?.target,
    draft, error,
  })).catch(cause => setError(message(cause)))}>{t('contentBrowser.packAuthoring.addWithAgent')}</Button> : null;

  if (!projectId) return <p className="cb-author-note">{t('contentBrowser.packAuthoring.openProject')}</p>;
  if (closed) return <div className="cb-pack-author"><p>{t('contentBrowser.packAuthoring.draftClosed')}</p><Button size="compact" onClick={() => { void author?.open().catch(cause => setError(message(cause))); }}>{t('contentBrowser.packAuthoring.reopen')}</Button></div>;
  if (!draft) return <div className="cb-pack-author"><p role={error ? 'alert' : 'status'}>{error || t('contentBrowser.packAuthoring.reading')}</p>{error ? addParameter : null}</div>;
  const fields = draft.fields;
  const buildFields = fields.filter(field => typeof field.apply !== 'object');
  const liveFields = fields.filter(field => typeof field.apply === 'object');
  return <section className="cb-pack-author" aria-label={t('contentBrowser.packAuthoring.title')} data-draft-id={draft.id}>
    <div className="cb-author-status" role="status">
      <Status tone={draft.unsaved || pending || saving ? 'warning' : 'success'} pill>{t(saving ? 'contentBrowser.packAuthoring.saving' : draft.unsaved || pending ? 'contentBrowser.packAuthoring.unsaved' : 'contentBrowser.packAuthoring.saved')}</Status>
      {buildFields.length ? <Status tone={draft.needsGeneration ? 'warning' : 'success'} pill>{t(draft.needsGeneration ? 'contentBrowser.packAuthoring.needsGeneration' : 'contentBrowser.packAuthoring.generated')}</Status> : null}
    </div>
    {matchingPreviews.length > 1 ? <Field label={t('contentBrowser.packAuthoring.previewTarget')}><Select aria-label={t('contentBrowser.packAuthoring.previewTarget')} value={previewTargetId ?? ''} onChange={event => selectTarget(event.target.value)}><option value="">{t('contentBrowser.packAuthoring.choosePreview')}</option>{matchingPreviews.map(p => <option key={p.target?.targetId} value={p.target?.targetId}>{p.asset?.name ?? p.asset?.sourceKey ?? p.target?.targetId}</option>)}</Select></Field> : null}
    <Toolbar className="cb-author-toolbar">
      <Tooltip content={t('contentBrowser.packAuthoring.save')} portaled disabled={(!draft.unsaved && !pending) || saving || draft.conflicts.length > 0}><IconButton size="compact" variant="primary" icon={<Save size={14} />} label={t('contentBrowser.packAuthoring.save')} title="" disabled={(!draft.unsaved && !pending) || saving || draft.conflicts.length > 0} loading={saving} onClick={() => void act('save')} /></Tooltip>
      <Tooltip content={t('contentBrowser.packAuthoring.undo')} portaled disabled={!draft.canUndo}><IconButton size="compact" variant="quiet" icon={<Undo2 size={14} />} label={t('contentBrowser.packAuthoring.undo')} title="" disabled={!draft.canUndo} onClick={() => void act('undo')} /></Tooltip>
      <Tooltip content={t('contentBrowser.packAuthoring.redo')} portaled disabled={!draft.canRedo}><IconButton size="compact" variant="quiet" icon={<Redo2 size={14} />} label={t('contentBrowser.packAuthoring.redo')} title="" disabled={!draft.canRedo} onClick={() => void act('redo')} /></Tooltip>
      <Tooltip content={t('contentBrowser.packAuthoring.refreshSource')} portaled><IconButton size="compact" variant="quiet" icon={<RefreshCw size={14} />} label={t('contentBrowser.packAuthoring.refreshSource')} title="" onClick={() => void act('refresh')} /></Tooltip>
    </Toolbar>
    {error || draft.error ? <p role="alert" className="cb-author-error">{error || message(draft.error)}</p> : null}
    {draft.conflicts.length > 0 ? <p role="alert" className="cb-author-error">{t('contentBrowser.packAuthoring.sourceConflict', { fields: draft.conflicts.join(', ') })}</p> : null}
    {buildFields.length ? <CollapsibleSection className="cb-author-group" title={t('contentBrowser.packAuthoring.generationParameters')}>
      <p className="cb-author-note">{t('contentBrowser.packAuthoring.generationNote')}</p>
      {buildFields.map(field => <PackField key={field.name} field={field} value={draft.values[field.name]} onChange={value => edit(field.name, value)} />)}
      <Button size="compact" className="cb-author-group-action" disabled={generating || draft.conflicts.length > 0} loading={generating} onClick={() => void act('generate')}>{t(generating ? 'contentBrowser.packAuthoring.generating' : 'contentBrowser.packAuthoring.generate')}</Button>
    </CollapsibleSection> : null}
    {liveFields.length ? <CollapsibleSection className="cb-author-group" title={t('contentBrowser.packAuthoring.runtimeParameters')}>
      <p className="cb-author-note">{t('contentBrowser.packAuthoring.runtimeNote')}</p>
      {liveFields.map(field => <PackField key={field.name} field={field} value={draft.values[field.name]} onChange={value => edit(field.name, value)} />)}
      {!previewTargetId ? <p className="cb-author-note">{t('contentBrowser.packAuthoring.openOutput')}</p> : draft.preview !== 'ready' ? <p className="cb-author-note">{t(draft.preview === 'pending' ? 'contentBrowser.packAuthoring.adjustToPreview' : 'contentBrowser.packAuthoring.previewUnavailable')}</p> : null}
    </CollapsibleSection> : null}
    {!fields.length ? <p className="cb-author-note">{t(addParameter ? 'contentBrowser.packAuthoring.noParametersAgent' : 'contentBrowser.packAuthoring.noParametersSource')}</p> : null}
    {addParameter}
    <div className="cb-author-footer">
      {!buildFields.length && sourcePath.endsWith('.pack.ts') ? <Button size="compact" title={t('contentBrowser.packAuthoring.rebuildHint')} disabled={generating || draft.conflicts.length > 0} loading={generating} onClick={() => void act('generate')}>{t(generating ? 'contentBrowser.packAuthoring.rebuilding' : 'contentBrowser.packAuthoring.rebuildSource')}</Button> : null}
      <Button size="compact" variant="quiet" disabled={!draft.unsaved && !pending} onClick={() => void act('discard')}>{t('contentBrowser.packAuthoring.discardChanges')}</Button>
      <Button size="compact" variant="quiet" onClick={() => draft.unsaved || pending ? setCloseChoice(true) : void act('close')}>{t('contentBrowser.packAuthoring.closeDraft')}</Button>
    </div>
    <Dialog open={closeChoice} onClose={() => setCloseChoice(false)} title={t('contentBrowser.packAuthoring.unsavedDialog')} closeLabel={t('contentBrowser.packAuthoring.cancel')}
      footer={<>
        <Button size="compact" variant="primary" onClick={() => { setCloseChoice(false); void act('save').then(saved => { if (saved) return act('close'); }); }}>{t('contentBrowser.packAuthoring.saveAndClose')}</Button>
        <Button size="compact" onClick={() => { setCloseChoice(false); void act('close', true); }}>{t('contentBrowser.packAuthoring.discardAndClose')}</Button>
        <Button size="compact" variant="quiet" onClick={() => setCloseChoice(false)}>{t('contentBrowser.packAuthoring.cancel')}</Button>
      </>}>{t('contentBrowser.packAuthoring.saveBeforeClose')}</Dialog>
  </section>;
}

function PackField({ field, value, onChange }: { field: PackDraftField; value: unknown; onChange: (value: unknown) => void }) {
  const [text, setText] = useState(display(value));
  const [invalid, setInvalid] = useState(false);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) { setText(display(value)); setInvalid(false); } }, [value]);
  const label = fieldLabel(field);
  const isColor = field.type === 'color' || (['vec3', 'vec4'].includes(field.type) && /color|tint/i.test(label));
  const change = (next: string) => {
    setText(next);
    try {
      const parsed = ['string', 'asset-guid', 'enum'].includes(field.type) ? next : JSON.parse(next);
      const valid = normalizeParameterValue(field, parsed, field.name);
      setInvalid(!valid.ok); if (valid.ok) onChange(valid.value);
    } catch { setInvalid(true); }
  };
  return <PropertyRow label={label}><div className="cb-author-field">
    {isColor ? <ColorPicker label={label} value={Array.isArray(value) ? value : [1, 1, 1]}
      onChange={color => {
      const next = field.type === 'vec4' || (Array.isArray(value) && value.length === 4) ? [...color] : color.slice(0, 3);
      setText(display(next)); onChange(next);
    }} /> : null}
    {field.type === 'bool' ? <Switch label={label} hideLabel checked={value === true} onCheckedChange={onChange} />
      : field.type === 'enum' ? <Select aria-label={label} value={String(value)} onChange={event => onChange(event.target.value)}>
        {(field.values ?? []).map(choice => <option key={String(choice)} value={String(choice)}>{String(choice)}</option>)}
      </Select> : <TextInput aria-label={label} aria-invalid={invalid} value={text} onFocus={() => { focused.current = true; }} onBlur={() => { focused.current = false; }} onChange={event => change(event.target.value)} />}
  </div></PropertyRow>;
}
