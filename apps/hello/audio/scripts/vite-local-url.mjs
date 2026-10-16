const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');

export function extractViteLocalUrl(output) {
  return output.replace(ANSI_RE, '').match(/Local:\s+(http:\/\/\S+)/)?.[1];
}
