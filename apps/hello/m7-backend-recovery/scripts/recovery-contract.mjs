export function isRetryableAdapterRecoveryFailure(detail) {
  return detail?.phase === 'acquire-adapter' && detail?.retryable === true;
}
