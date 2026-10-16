const ANSI_ESCAPE_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;

export function parseViteServerUrl(output) {
  const normalized = output.replace(ANSI_ESCAPE_PATTERN, '');
  return normalized.match(/Local:\s+(https?:\/\/[^\s]+)/)?.[1];
}
