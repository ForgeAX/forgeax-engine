import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { clientLabels } from './client-i18n';

import {
  type EnginePreviewStatus,
  FEDERATION_PROTOCOL_VERSION,
  FEDERATION_ROUTE_PREFIX,
  type FederationStatus,
  isEnginePreviewStatus,
  isFederationStatus,
} from './protocol';

interface SlotService {
  inject(name: string, callback: () => () => void): void;
  register(options: Readonly<Record<string, unknown>>, component: React.ComponentType): () => void;
}

interface ClientContext {
  readonly slots: SlotService;
}

export const inject = ['slots'];

export interface ClientConfig {
  readonly locale?: string;
}

export function apply(ctx: ClientContext, config: ClientConfig = {}): void {
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'forgeax-engine',
        order: 80,
        label: 'ForgeAX Engine',
      },
      () => <ForgeAXPanel locale={config.locale ?? 'en'} />,
    ),
  );
}

function ForgeAXPanel({ locale }: { readonly locale: string }): React.JSX.Element {
  const [language, setLanguage] = useState(locale);
  const labels = clientLabels(language);
  const [open, setOpen] = useState(true);
  const [realm, setRealm] = useState<FederationStatus>();
  const [engine, setEngine] = useState<EnginePreviewStatus>();
  const iframe = useRef<HTMLIFrameElement>(null);

  const readRealm = useCallback(async (): Promise<void> => {
    const response = await fetch(`${FEDERATION_ROUTE_PREFIX}/status`, { cache: 'no-store' });
    if (!response.ok) return;
    const value: unknown = await response.json();
    if (isFederationStatus(value)) setRealm(value);
  }, []);

  const engineEndpoint = realm?.engine.binding === 'external' ? realm.engine.endpoint : undefined;

  useEffect(() => {
    if (!open) return;
    void readRealm();
    const realmTimer = window.setInterval(() => void readRealm(), 1_000);
    return () => window.clearInterval(realmTimer);
  }, [open, readRealm]);

  useEffect(() => {
    if (!open || engineEndpoint === undefined) return;
    const pollTimer = window.setInterval(() => {
      const target = iframe.current?.contentWindow;
      if (target == null) return;
      target.postMessage(
        { protocol: FEDERATION_PROTOCOL_VERSION, kind: 'forgeax-engine-poll' },
        new URL(engineEndpoint).origin,
      );
    }, 250);
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== iframe.current?.contentWindow || !isEnginePreviewStatus(event.data))
        return;
      setEngine(event.data);
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.clearInterval(pollTimer);
      window.removeEventListener('message', onMessage);
    };
  }, [engineEndpoint, open]);

  const control = (): void => {
    if (realm?.engine.binding === 'external') {
      iframe.current?.contentWindow?.postMessage(
        {
          protocol: FEDERATION_PROTOCOL_VERSION,
          kind: 'forgeax-engine-control',
          action: 'toggle',
        },
        new URL(realm.engine.endpoint).origin,
      );
      return;
    }
    void fetch(`${FEDERATION_ROUTE_PREFIX}/engine/control`, { method: 'POST' }).then(() =>
      readRealm(),
    );
  };

  const projection =
    realm?.engine.binding === 'external'
      ? engine
      : realm?.engine.binding === 'embedded'
        ? realm.engine
        : undefined;

  return (
    <section
      data-forgeax-panel="mounted"
      lang={labels.lang}
      style={{
        position: 'fixed',
        right: 18,
        bottom: 18,
        zIndex: 100,
        width: open ? 'min(680px, calc(100vw - 36px))' : 210,
        border: '1px solid rgba(94, 234, 212, 0.42)',
        borderRadius: 16,
        overflow: 'hidden',
        color: '#e6fffb',
        background: 'rgba(5, 14, 25, 0.96)',
        boxShadow: '0 24px 70px rgba(0, 0, 0, 0.55)',
        pointerEvents: 'auto',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      }}
    >
      <header
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '11px 14px',
          background: 'linear-gradient(90deg, rgba(13,148,136,.28), rgba(37,99,235,.18))',
        }}
      >
        <div>
          <strong style={{ fontSize: 14 }}>ForgeAX Engine</strong>
          <span
            data-forgeax-ready={realm?.ready === true ? 'true' : 'false'}
            style={{
              marginLeft: 9,
              color: realm?.ready === true ? '#5eead4' : '#fbbf24',
              fontSize: 12,
            }}
          >
            {realm?.ready === true ? labels.ready : labels.connecting}
          </span>
        </div>
        <select
          aria-label={labels.language}
          data-forgeax-language="true"
          value={labels.lang}
          onChange={(event) => setLanguage(event.target.value)}
          style={buttonStyle}
        >
          <option value="en">{labels.languageEnglish}</option>
          <option value="zh-CN">{labels.languageChinese}</option>
        </select>
        <button
          data-forgeax-preview-toggle="true"
          type="button"
          onClick={() => setOpen((value) => !value)}
          style={buttonStyle}
        >
          {open ? labels.hidePreview : labels.showPreview}
        </button>
      </header>
      {open ? (
        <div style={{ padding: 12 }}>
          <div
            data-forgeax-status="live"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: 8,
              marginBottom: 10,
            }}
          >
            <Fact
              id="binding"
              label={labels.binding}
              value={labels[realm?.engine.binding ?? 'pending']}
            />
            <Fact id="frameId" label={labels.frameId} value={String(projection?.frameId ?? 0)} />
            <Fact id="tick" label={labels.tick} value={String(projection?.tick ?? 0)} />
            <Fact id="state" label={labels.state} value={String(projection?.state ?? 0)} />
          </div>
          {engineEndpoint !== undefined ? (
            <iframe
              ref={iframe}
              data-forgeax-engine-frame="real"
              src={engineEndpoint}
              title={labels.previewTitle}
              onLoad={() => {
                iframe.current?.contentWindow?.postMessage(
                  { protocol: FEDERATION_PROTOCOL_VERSION, kind: 'forgeax-engine-poll' },
                  new URL(engineEndpoint).origin,
                );
              }}
              style={{
                display: 'block',
                width: '100%',
                height: 390,
                border: '1px solid rgba(148,163,184,.25)',
                borderRadius: 10,
                background: '#020617',
              }}
            />
          ) : (
            <div
              data-forgeax-headless="true"
              style={{
                display: 'grid',
                placeItems: 'center',
                height: 180,
                borderRadius: 10,
                color: '#94a3b8',
                background: 'radial-gradient(circle at center, #123047, #020617 70%)',
              }}
            >
              {labels.headless}
            </div>
          )}
          <footer
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginTop: 10,
            }}
          >
            <span style={{ color: '#94a3b8', fontSize: 12 }}>
              {labels.loader} · {labels.leases} {realm?.leases ?? 0} · {labels.protocol}{' '}
              {realm?.protocol ?? '–'}
            </span>
            <button
              data-forgeax-control="toggle"
              type="button"
              onClick={control}
              style={buttonStyle}
            >
              {labels.toggleState}
            </button>
          </footer>
        </div>
      ) : null}
    </section>
  );
}

function Fact({
  id,
  label,
  value,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
}): React.JSX.Element {
  return (
    <div style={{ padding: '7px 9px', borderRadius: 8, background: 'rgba(15, 23, 42, .9)' }}>
      <div
        style={{
          color: '#64748b',
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '.08em',
        }}
      >
        {label}
      </div>
      <div
        data-forgeax-fact={id}
        style={{ color: '#f8fafc', fontSize: 13, fontVariantNumeric: 'tabular-nums' }}
      >
        {value}
      </div>
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  padding: '6px 10px',
  border: '1px solid rgba(94,234,212,.35)',
  borderRadius: 8,
  color: '#ccfbf1',
  background: 'rgba(15,118,110,.25)',
  cursor: 'pointer',
  fontSize: 12,
};
