import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Text } from '../components';

export const specimenGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
  gap: 12,
};

export function SpecSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section style={{ display: 'grid', gap: 18, maxWidth: 1080 }}>
      <div style={{ display: 'grid', gap: 6 }}>
        <Text as="h2" variant="title">{title}</Text>
        {description && <Text variant="body" tone="secondary">{description}</Text>}
      </div>
      {children}
    </section>
  );
}

export function useResolvedToken(token: string) {
  const [value, setValue] = useState('');
  useEffect(() => {
    const update = () => {
      setValue(getComputedStyle(document.documentElement).getPropertyValue(token).trim());
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, [token]);
  return value;
}

export function TokenValue({ token }: { token: string }) {
  const value = useResolvedToken(token);
  return (
    <Text as="span" variant="code" tone="muted">
      {token} · {value}
    </Text>
  );
}

export function ColorSpec({
  token,
  name,
  description,
}: {
  token: string;
  name: string;
  description: string;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateRows: '64px auto',
        overflow: 'hidden',
        border: 'var(--fx-border-width) solid var(--fx-color-border-default)',
        borderRadius: 'var(--fx-radius-card)',
        background: 'var(--fx-color-surface-raised)',
      }}
    >
      <div style={{ background: `var(${token})` }} />
      <div style={{ display: 'grid', gap: 4, padding: 12 }}>
        <Text as="strong" variant="label">{name}</Text>
        <Text variant="caption">{description}</Text>
        <TokenValue token={token} />
      </div>
    </div>
  );
}
