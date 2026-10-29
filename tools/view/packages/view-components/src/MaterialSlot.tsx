import type { ReactNode } from 'react';

/** Presentation only; the caller supplies owner facts and reference actions. */
export function MaterialSlot({ index, name, source, children, testId }: {
  index: number;
  name?: string;
  source?: string;
  children: ReactNode;
  testId?: string;
}) {
  return <div className="fx-material-slot" data-testid={testId}>
    {name ? <div className="fx-material-slot__heading">
      <span title={name}>{index} · {name}</span>
      {source ? <span className="fx-material-slot__source">{source}</span> : null}
    </div> : null}
    <div className="fx-material-slot__item">
      <span className="fx-material-slot__index" title={name}>{index}</span>
      <div className="fx-material-slot__reference">{children}</div>
    </div>
  </div>;
}
