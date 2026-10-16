import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Base64DecodeError, dataUriBase64Payload, decodeBase64 } from '../data-uri.js';

const ownerSource = readFileSync(new URL('../data-uri.ts', import.meta.url), 'utf8');
const parseSource = readFileSync(new URL('../parse-gltf.ts', import.meta.url), 'utf8');
const extractSource = readFileSync(new URL('../extract-image-bytes.ts', import.meta.url), 'utf8');

describe('data URI helper surface', () => {
  it('owns matching, payload preservation, and browser-safe decoding', () => {
    const payload = dataUriBase64Payload('data:application/octet-stream;base64,AAE=');

    expect(payload).toBe('AAE=');
    expect(dataUriBase64Payload('https://example.com/mesh.bin')).toBeUndefined();
    expect(dataUriBase64Payload('data:application/octet-stream;base64,')).toBe('');
    expect([...decodeBase64(payload ?? '')]).toEqual([0, 1]);
    expect(() => decodeBase64('%%%%')).toThrow(Base64DecodeError);
    expect(ownerSource.match(/const DATA_URI_BASE64_RE =/g)).toHaveLength(1);
    expect(parseSource).not.toMatch(/const DATA_URI_BASE64_RE =/);
    expect(extractSource).not.toMatch(/const DATA_URI_BASE64_RE =/);
    expect(parseSource).not.toMatch(/function decodeBase64/);
    expect(extractSource).not.toMatch(/function decodeBase64/);
    expect(parseSource).toMatch(/dataUriBase64Payload/);
    expect(extractSource).toMatch(/dataUriBase64Payload/);
  });
});
