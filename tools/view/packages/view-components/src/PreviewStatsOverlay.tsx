import type { ReactNode } from 'react';

export type PreviewStatsRow = { id: string; label: ReactNode; value: ReactNode };

/** Non-interactive viewport text; visibility belongs to the consuming preview. */
export function PreviewStatsOverlay({ label, rows }: { label: string; rows: readonly PreviewStatsRow[] }) {
  return (
    <dl className="fx-preview-stats" aria-label={label} data-testid="preview-stats">
      {rows.map(row => <div key={row.id}><dt>{row.label}:</dt><dd>{row.value}</dd></div>)}
    </dl>
  );
}
