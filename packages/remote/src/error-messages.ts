import type { RemoteErrorCode } from './errors';

export const REMOTE_ERROR_MESSAGES: Readonly<Record<RemoteErrorCode, string>> = {
  'script-syntax-error': 'Script syntax error',
  'script-runtime-error': 'Script runtime error',
  'server-startup-failed': 'Server startup failed',
  'server-not-running': 'Server not reachable',
  'eval-result-not-serializable': 'Eval result not serializable',
};
