const DATA_URI_BASE64_RE = /^data:[^;,]*(?:;[^,;]+)*;base64,(.*)$/;

export class Base64DecodeError extends Error {
  constructor(cause: unknown) {
    super(
      `base64 payload decode failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'Base64DecodeError';
  }
}

export function dataUriBase64Payload(uri: string): string | undefined {
  const match = DATA_URI_BASE64_RE.exec(uri);
  return match === null ? undefined : (match[1] ?? '');
}

export function decodeBase64(b64: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(b64);
  } catch (cause) {
    throw new Base64DecodeError(cause);
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
