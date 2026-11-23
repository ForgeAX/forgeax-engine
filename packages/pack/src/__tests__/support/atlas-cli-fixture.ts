import { writeFile } from 'node:fs/promises';

interface CapturedIO {
  stdout: string[];
  stderr: string[];
}

export function makeIO(): CapturedIO {
  return { stdout: [], stderr: [] };
}

export function ctxFor(io: CapturedIO) {
  return {
    stdoutWrite: (line: string): void => {
      io.stdout.push(line);
    },
    stderrWrite: (line: string): void => {
      io.stderr.push(line);
    },
  };
}

interface UpngEncode {
  encode: (imgs: ArrayBuffer[], w: number, h: number, cnum: number) => ArrayBuffer;
}

async function loadUpng(): Promise<UpngEncode> {
  const mod = (await import('upng-js')) as { default?: UpngEncode } & UpngEncode;
  return (mod.default ?? mod) as UpngEncode;
}

export async function writeSolidPng(
  path: string,
  width: number,
  height: number,
  rgba: [number, number, number, number],
): Promise<void> {
  const upng = await loadUpng();
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4 + 0] = rgba[0];
    pixels[i * 4 + 1] = rgba[1];
    pixels[i * 4 + 2] = rgba[2];
    pixels[i * 4 + 3] = rgba[3];
  }
  const buf = upng.encode([pixels.buffer as ArrayBuffer], width, height, 0);
  await writeFile(path, Buffer.from(buf));
}
