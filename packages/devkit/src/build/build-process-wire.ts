import { deserialize, Serializer } from 'node:v8';

/** Advanced IPC alone rehomes typed views inside its message storage. */
export function encodeBuildMessage(value: unknown): Uint8Array {
  const serializer = new Serializer();
  serializer.writeHeader();
  serializer.writeValue(value);
  return serializer.releaseBuffer();
}

export function decodeBuildMessage(bytes: Uint8Array): unknown {
  return deserialize(bytes);
}
