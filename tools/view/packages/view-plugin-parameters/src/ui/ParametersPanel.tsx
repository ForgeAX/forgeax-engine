import { normalizeParameterValue } from '@forgeax/engine-pack/source';
import { createPackAuthoringClient, packParameterReference, type PackDraftField } from '@forgeax/view-workspace-core/pack-authoring';
import { Button, ColorPicker, colorHex, EmptyState, Field, formatInspectorFieldLabel, IconButton, PanelHeader, parseColorHex, PropertyRow, roundColorValue, Select, Switch, Text, TextInput, toColorValue, Tooltip } from '@forgeax/view-components';
import type { ViewWorkspaceClient } from '@forgeax/view-workspace-core/client';
import { createWorkspaceStateReader } from '@forgeax/view-workspace-core/workspace-state';
import { generationPreviewTargetId, partitionPackFields, resolveAssetPageBinding } from '../field-partition.ts';
import { ChevronDown, ChevronRight, CircleHelp, RotateCcw, Save, SlidersHorizontal } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from '../i18n/useTranslation.ts';
import './parameters.css';

function display(value: unknown): string { return typeof value === 'string' ? value : JSON.stringify(value) ?? ''; }
function displayFieldValue(value: unknown, isColor: boolean): string {
  return isColor && Array.isArray(value) && value.length >= 3
    && value.slice(0, 3).every(channel => typeof channel === 'number' && Number.isFinite(channel))
    ? colorHex(toColorValue(value)) : display(value);
}
function sameParameterValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => Object.is(value, right[index]));
}
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
export function ParametersPanel({ client, sourcePath, addConversationReference, mode = 'generation', assetPage }: {
  client: ViewWorkspaceClient;
  sourcePath?: string;
  mode?: 'generation' | 'runtime';
  assetPage?: { getResource(): { asset: { guid: string; kind: string } } | { file: unknown } | undefined; subscribe(listener: () => void): () => void; onBeforeClose(listener: (signal: AbortSignal) => void | Promise<void>): () => void };
  addConversationReference?: (reference: { title: string; text: string }) => Promise<void>;
}) {
  const { t, locale } = useTranslation();
  const reader = useMemo(() => createWorkspaceStateReader(client), [client]);
  const workspace = useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot);
  const projectId = workspace?.project?.id;
  const pageResourceRevision = useSyncExternalStore(assetPage?.subscribe ?? (() => () => {}), () => {
    const current = assetPage?.getResource();
    return current && 'asset' in current ? `${current.asset.guid}\0${current.asset.kind}` : '';
  }, () => '');
  const assetBinding = mode === 'runtime' ? resolveAssetPageBinding(assetPage?.getResource(), workspace?.assets) : undefined;
  const pageAssetIdentity = assetBinding?.asset;
  const sourceKey = assetBinding?.sourceKey;
  const effectiveSourcePath = mode === 'runtime' ? assetBinding?.sourcePath : sourcePath;
  const [error, setError] = useState('');
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [expandedSourceKey, setExpandedSourceKey] = useState<string>();
  const showOtherDomains = !!sourceKey && expandedSourceKey === sourceKey;
  const frame = useRef<number | undefined>(undefined);
  const previews = workspace?.previews ?? [];
  const [selectedTarget, selectTarget] = useState<string>();
  const matchingPreviews = previews.filter(preview => {
    if (mode === 'runtime') return !!pageAssetIdentity && preview.asset?.guid === pageAssetIdentity.guid && preview.asset?.kind === pageAssetIdentity.kind;
    const path = preview.asset?.sourcePath ?? preview.asset?.path;
    return path === effectiveSourcePath || (path && workspace?.project?.root && path === `${workspace.project.root}/${effectiveSourcePath}`);
  });
  const previewTargetId = mode === 'generation'
    ? generationPreviewTargetId(matchingPreviews)
    : selectedTarget && matchingPreviews.some(p => p.target?.targetId === selectedTarget) ? selectedTarget : matchingPreviews.length === 1 ? matchingPreviews[0]?.target?.targetId : undefined;
  const sameSource = (path: string | undefined) => !!effectiveSourcePath && !!path && (path === effectiveSourcePath || (!!workspace?.project?.root && path === `${workspace.project.root}/${effectiveSourcePath}`));
  const packAssetGuids = new Set(workspace?.assets?.filter(asset => sameSource(asset.sourcePath ?? asset.path)).map(asset => asset.guid));
  const packPreviews = previews
    .filter(preview => preview.asset && (packAssetGuids.has(preview.asset.guid) || sameSource(preview.asset.sourcePath ?? preview.asset.path)));
  const packPreviewTargetIds = packPreviews
    .sort((left, right) => Number(left.asset?.kind === 'scene') - Number(right.asset?.kind === 'scene'))
    .map(preview => preview.target.targetId);
  const previewBySourceKey = new Map(packPreviews.map(preview => [
    preview.asset?.sourceKey ?? workspace?.assets?.find(asset => asset.guid === preview.asset?.guid)?.sourceKey,
    preview.target.targetId,
  ]));
  const previewRef = useRef(previewTargetId);
  previewRef.current = previewTargetId;
  const packPreviewRefs = useRef(packPreviewTargetIds);
  packPreviewRefs.current = packPreviewTargetIds;
  const previewBySourceKeyRef = useRef(previewBySourceKey);
  previewBySourceKeyRef.current = previewBySourceKey;

  const sessionId = workspace?.projectTarget?.sessionId;
  const targetId = workspace?.projectTarget?.targetId;
  const [author, setAuthor] = useState<ReturnType<typeof createPackAuthoringClient>>();
  const [presentation, setPresentation] = useState<ReturnType<ReturnType<typeof createPackAuthoringClient>['getSnapshot']>>({ pending: false, closed: false });
  const { draft, pending, closed } = presentation;
  const observedPreview = useRef<{ author: typeof author; draftId: string; targetId: string } | undefined>(undefined);
  useEffect(() => {
    setPresentation({ pending: false, closed: false }); setError('');
    if (!projectId || !sessionId || !targetId) { setAuthor(undefined); return; }
    if (!effectiveSourcePath) { setAuthor(undefined); return; }
    const current = createPackAuthoringClient(client, { projectId, sessionId, targetId, sourcePath: effectiveSourcePath, previewTargetId: () => previewRef.current, previewTargetIdForAsset: key => previewBySourceKeyRef.current.get(key), previewTargetIds: () => packPreviewRefs.current });
    setAuthor(current);
    let disposed = false;
    const unsubscribe = current.subscribe(() => {
      const next = current.getSnapshot();
      setPresentation(next);
      if (next.draft) setError('');
    });
    const unsubscribeClose = mode === 'runtime' ? assetPage?.onBeforeClose(signal => {
      signal.throwIfAborted();
      return current.flush();
    }) : undefined;
    void current.open().catch(cause => { if (!disposed) setError(message(cause)); });
    return () => {
      disposed = true; unsubscribeClose?.(); unsubscribe(); current.dispose();
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      frame.current = undefined;
    };
  }, [assetPage, client, effectiveSourcePath, mode, pageResourceRevision, projectId, sessionId, targetId]);

  useEffect(() => {
    if (mode !== 'runtime' || !author || !draft?.id || !previewTargetId || !effectiveSourcePath || (draft.sourcePath !== effectiveSourcePath && !effectiveSourcePath.endsWith(`/${draft.sourcePath}`))) return;
    if (observedPreview.current?.author === author && observedPreview.current.draftId === draft.id && observedPreview.current.targetId === previewTargetId) return;
    observedPreview.current = { author, draftId: draft.id, targetId: previewTargetId };
    if (!draft.fields.some(field => typeof field.apply === 'object' && !sameParameterValue(draft.values[field.name], field.default))) return;
    void author.syncPreviews().catch(cause => setError(message(cause)));
  }, [author, draft?.id, draft?.sourcePath, draft?.unsaved, effectiveSourcePath, mode, previewTargetId]);

  useEffect(() => {
    if (!draft?.unsaved && !pending) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [draft?.unsaved, pending]);

  const act = async (action: Parameters<NonNullable<typeof author>['act']>[0]) => {
    if (!author) return false;
    setError('');
    if (action === 'generate') setGenerating(true);
    if (action === 'save') setSaving(true);
    if (action === 'discard') setRestoring(true);
    try { await author.act(action); return true; }
    catch (cause) { setError(message(cause)); return false; }
    finally { setGenerating(false); setSaving(false); setRestoring(false); }
  };
  const edit = (field: string, value: unknown) => {
    author?.edit(field, value);
    if (frame.current === undefined) frame.current = requestAnimationFrame(() => {
      frame.current = undefined;
      void author?.flush().catch(cause => setError(message(cause)));
    });
  };

  const addParameter = addConversationReference && effectiveSourcePath?.endsWith('.pack.ts') ? <Button size="compact" className="cb-author-add-parameter" onClick={() => void addConversationReference(packParameterReference({
    sourcePath: effectiveSourcePath, project: workspace?.project,
    target: matchingPreviews.find(preview => preview.target.targetId === previewTargetId)?.target,
    draft, error,
  })).catch(cause => setError(message(cause)))}>{t('contentBrowser.packAuthoring.addWithAgent')}</Button> : null;

  if (!projectId) return <p className="cb-author-note">{t('contentBrowser.packAuthoring.openProject')}</p>;
  if (mode === 'runtime' && (!assetBinding || !effectiveSourcePath)) return <div className="cb-parameters-empty-surface">
    <EmptyState role="status" className="cb-parameters-empty" icon={<CircleHelp />} title={t('contentBrowser.packAuthoring.runtimeBindingUnavailableTitle')} description={t('contentBrowser.packAuthoring.runtimeBindingUnavailableDescription')} />
  </div>;
  if (closed) return <div className="cb-pack-author"><p>{t('contentBrowser.packAuthoring.draftClosed')}</p><Button size="compact" onClick={() => { void author?.open().catch(cause => setError(message(cause))); }}>{t('contentBrowser.packAuthoring.reopen')}</Button></div>;
  if (!draft) return <div className="cb-pack-author"><p role={error ? 'alert' : 'status'}>{error || t('contentBrowser.packAuthoring.reading')}</p>{error ? addParameter : null}</div>;
  const fields = draft.fields;
  const { generation: buildFields, runtime: liveFields } = partitionPackFields(fields, sourceKey);
  const otherDomains = new Map<string, PackDraftField[]>();
  if (mode === 'runtime') for (const field of fields) {
    if (typeof field.apply !== 'object' || field.apply.asset === sourceKey) continue;
    const domain = otherDomains.get(field.apply.asset) ?? [];
    domain.push(field);
    otherDomains.set(field.apply.asset, domain);
  }
  const draftDirty = pending || draft.unsaved;
  if (mode === 'runtime' && !liveFields.length && !otherDomains.size && !draftDirty) return <div className="cb-parameters-empty-surface">
    <EmptyState role="status" className="cb-parameters-empty" icon={<SlidersHorizontal />} title={t('contentBrowser.packAuthoring.noRuntimeParametersTitle')} description={t('contentBrowser.packAuthoring.noRuntimeParametersDescription')} />
    {error || draft.error ? <p role="alert" className="cb-author-error">{error || message(draft.error)}</p> : null}
    {draft.conflicts.length ? <p role="alert" className="cb-author-error">{t('contentBrowser.packAuthoring.sourceConflict', { fields: draft.conflicts.join(', ') })}</p> : null}
  </div>;
  const resetFieldLabel = t('contentBrowser.packAuthoring.resetField');
  const rows = (visibleFields: readonly PackDraftField[]) => visibleFields.map(field => <div className="fx-inspector-form__row cb-author-param-row" key={field.name}>
    <PackField inspectorStyle locale={locale} field={field} value={draft.values[field.name]}
      onChange={value => edit(field.name, value)} />
    <span className="cb-author-field-reset">{!sameParameterValue(draft.values[field.name], field.default) ? <Tooltip content={resetFieldLabel} portaled>
      <IconButton size="compact" variant="quiet" icon={<RotateCcw size={14} />} label={`${resetFieldLabel}: ${fieldLabel(field)}`} title="" onClick={() => edit(field.name, field.default)} />
    </Tooltip> : null}</span>
  </div>);
  return <section className={`cb-pack-author${mode === 'runtime' ? ' cb-pack-author--runtime fx-inspector-form' : mode === 'generation' ? ' cb-pack-author--generation fx-inspector-form' : ''}`} aria-label={t('contentBrowser.packAuthoring.title')} data-draft-id={draft.id}>
    <PanelHeader className="cb-parameter-panel-header" end={<span className="cb-parameter-header-actions">
      {draftDirty ? <>
        <Tooltip content={t('contentBrowser.packAuthoring.save')} portaled>
          <IconButton size="compact" variant="primary" icon={<Save size={14} />} label={t('contentBrowser.packAuthoring.save')} title="" disabled={saving || restoring || draft.conflicts.length > 0} loading={saving} onClick={() => void act('save')} />
        </Tooltip>
        <Tooltip content={t('contentBrowser.packAuthoring.restoreDefaultsTooltip')} portaled>
          <IconButton size="compact" variant="quiet" icon={<RotateCcw size={14} />} label={t('contentBrowser.packAuthoring.restoreDefaults')} title="" disabled={saving || restoring} loading={restoring} onClick={() => void act('discard')} />
        </Tooltip>
      </> : <Text as="span" variant="caption" tone="secondary" className="cb-parameter-editable">{t('contentBrowser.packAuthoring.editable')}</Text>}
    </span>} />
    {mode === 'runtime' && matchingPreviews.length > 1 ? <Field className="cb-author-preview-target" label={t('contentBrowser.packAuthoring.previewTarget')}><Select aria-label={t('contentBrowser.packAuthoring.previewTarget')} value={previewTargetId ?? ''} onChange={event => selectTarget(event.target.value)}><option value="">{t('contentBrowser.packAuthoring.choosePreview')}</option>{matchingPreviews.map(p => <option key={p.target?.targetId} value={p.target?.targetId}>{p.asset?.name ?? p.asset?.sourceKey ?? p.target?.targetId}</option>)}</Select></Field> : null}
    {error || draft.error ? <p role="alert" className="cb-author-error">{error || message(draft.error)}</p> : null}
    {draft.conflicts.length > 0 ? <p role="alert" className="cb-author-error">{t('contentBrowser.packAuthoring.sourceConflict', { fields: draft.conflicts.join(', ') })}</p> : null}
    {mode === 'generation' ? buildFields.length ? <>
      {rows(buildFields)}
      <Button size="compact" variant="primary" className="cb-author-generate-action" disabled={!previewTargetId || generating || draft.conflicts.length > 0} loading={generating} onClick={() => void act('generate')}>{t(generating ? 'contentBrowser.packAuthoring.generating' : 'contentBrowser.packAuthoring.generate')}</Button>
    </> : <>
      <p className="cb-author-note">{t(addParameter ? 'contentBrowser.packAuthoring.noParametersAgent' : 'contentBrowser.packAuthoring.noParametersSource')}</p>
      {effectiveSourcePath?.endsWith('.pack.ts') ? <Button size="compact" variant="primary" className="cb-author-generate-action" title={t('contentBrowser.packAuthoring.rebuildHint')} disabled={!previewTargetId || generating || draft.conflicts.length > 0} loading={generating} onClick={() => void act('generate')}>{t(generating ? 'contentBrowser.packAuthoring.rebuilding' : 'contentBrowser.packAuthoring.rebuildSource')}</Button> : null}
    </> : null}
    {mode === 'runtime' ? <>
      <Text as="div" variant="ui" tone="muted" className="cb-author-section-label">{t('contentBrowser.packAuthoring.currentAsset')}</Text>
      {liveFields.length ? rows(liveFields) : <p className="cb-author-note cb-author-note--runtime">{t('contentBrowser.packAuthoring.noOwnRuntimeParameters')}</p>}
      {otherDomains.size ? <Button size="compact" variant="quiet" className="cb-author-other-domains-toggle" leadingIcon={showOtherDomains ? <ChevronDown size={14} /> : <ChevronRight size={14} />} aria-expanded={showOtherDomains} onClick={() => setExpandedSourceKey(showOtherDomains ? undefined : sourceKey)}>
        {t('contentBrowser.packAuthoring.otherAssets')}
      </Button> : null}
      {showOtherDomains ? [...otherDomains].map(([domain, domainFields]) => <div key={domain} className="cb-author-other-domain">
        <Text as="div" variant="caption" tone="muted" className="cb-author-domain-label">{t('contentBrowser.packAuthoring.otherDomain', { domain })}</Text>
        {rows(domainFields)}
      </div>) : null}
      {!previewTargetId ? <p className="cb-author-note cb-author-note--runtime">{t('contentBrowser.packAuthoring.openOutput')}</p> : draft.preview === 'unavailable' ? <p className="cb-author-note cb-author-note--runtime">{t('contentBrowser.packAuthoring.previewUnavailable')}</p> : null}
    </> : null}
    {mode === 'generation' ? addParameter : null}
  </section>;
}

function PackField({ field, value, onChange, inspectorStyle = false, locale = 'en' }: { field: PackDraftField; value: unknown; onChange: (value: unknown) => void; inspectorStyle?: boolean; locale?: string }) {
  const label = fieldLabel(field);
  const isColor = field.type === 'color' || (['vec3', 'vec4'].includes(field.type) && /color|tint/i.test(label));
  const [text, setText] = useState(() => displayFieldValue(value, isColor));
  const [invalid, setInvalid] = useState(false);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) { setText(displayFieldValue(value, isColor)); setInvalid(false); } }, [value, isColor]);
  const change = (next: string) => {
    setText(isColor ? next.toUpperCase() : next);
    if (isColor) {
      const parsed = parseColorHex(next);
      if (!parsed) { setInvalid(true); return; }
      if (next.trim().replace(/^#/, '').toUpperCase() === displayFieldValue(value, isColor)) { setInvalid(false); return; }
      const rounded = roundColorValue(parsed);
      const color = field.type === 'vec4' || (Array.isArray(value) && value.length === 4) ? rounded : rounded.slice(0, 3);
      const valid = normalizeParameterValue(field, color, field.name);
      setInvalid(!valid.ok); if (valid.ok) onChange(valid.value);
      return;
    }
    try {
      const parsed = ['string', 'asset-guid', 'enum'].includes(field.type) ? next : JSON.parse(next);
      const valid = normalizeParameterValue(field, parsed, field.name);
      setInvalid(!valid.ok); if (valid.ok) onChange(valid.value);
    } catch { setInvalid(true); }
  };
  return <PropertyRow className={inspectorStyle ? 'fx-inspector-form__property' : undefined} label={label}><div className="cb-author-field">
    {isColor ? <ColorPicker label={label} locale={locale === 'zh' ? 'zh' : 'en'} value={Array.isArray(value) ? value : [1, 1, 1]}
      onChange={color => {
      const next = field.type === 'vec4' || (Array.isArray(value) && value.length === 4) ? [...color] : color.slice(0, 3);
      setText(displayFieldValue(next, isColor)); onChange(next);
    }} /> : null}
    {field.type === 'bool' ? <Switch label={label} hideLabel checked={value === true} onCheckedChange={onChange} />
      : field.type === 'enum' ? <Select className={inspectorStyle ? 'fx-inspector-form__input' : undefined} aria-label={label} value={String(value)} onChange={event => onChange(event.target.value)}>
        {(field.values ?? []).map(choice => <option key={String(choice)} value={String(choice)}>{String(choice)}</option>)}
      </Select> : <TextInput className={inspectorStyle ? 'fx-inspector-form__input' : undefined} aria-label={label} aria-invalid={invalid} value={text} onFocus={() => { focused.current = true; }} onBlur={() => { focused.current = false; }} onChange={event => change(event.target.value)} />}
  </div></PropertyRow>;
}
