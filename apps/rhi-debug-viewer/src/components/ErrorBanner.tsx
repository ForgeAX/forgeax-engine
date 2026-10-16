// ErrorBanner.tsx - renders closed core errors without parsing display text.
// The code is the branch coordinate; detail is structured evidence and hint is
// the next executable recovery action. Preview errors stay in the viewer leaf.

import type { RhiDebugError } from '@forgeax/engine-rhi-debug';
import { loadStatusAnchor } from '../selectors';

export interface ErrorBannerProps {
  readonly error: RhiDebugError;
}

export function ErrorBanner({ error }: ErrorBannerProps) {
  const detail = error.detail === undefined ? undefined : JSON.stringify(error.detail);
  const detailLabel = (() => {
    switch (error.code) {
      case 'capture-unavailable':
      case 'capture-busy':
      case 'capture-snapshot-failed':
      case 'capture-timeout':
      case 'tape-invalid':
      case 'replay-capability-mismatch':
      case 'replay-event-failed':
      case 'replay-position-invalid':
      case 'readback-failed':
      case 'readback-unsupported':
        return 'operation detail';
      case 'tape-version-unsupported':
        return `expected v${error.detail?.expectedVersion ?? 7}, found v${error.detail?.foundVersion ?? 0}`;
    }
  })();

  return (
    <div {...{ [loadStatusAnchor()]: 'parse-error' }} className="forgeax-error-banner space-y-fx-4">
      <p className="text-ui font-semibold text-danger">
        Error: <code>{error.code}</code>
      </p>
      <p className="text-caption">{error.hint}</p>
      <p className="text-caption">{detailLabel}</p>
      {detail !== undefined && <pre className="whitespace-pre-wrap text-code">{detail}</pre>}
    </div>
  );
}
