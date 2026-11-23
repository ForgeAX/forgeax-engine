import { expect, it } from 'vitest';
import {
  verifyFileStore,
  verifyRecordStore,
} from '../../../platform/src/__tests__/storage-contract.fixture';
import { createWechatFileStore, createWechatRecordStore } from '../storage';

interface Operation {
  filePath: string;
  oldPath: string;
  newPath: string;
  data: ArrayBuffer;
  arrayBuffer: ArrayBuffer;
  fd: string;
  flag: string;
  offset: number;
  position: number;
  length: number;
  success(value?: unknown): void;
  fail(value: unknown): void;
}

function sandbox() {
  const contents = new Map<string, Uint8Array>();
  const descriptors = new Map<string, string>();
  let failWrite = false;
  let sequence = 0;
  const missing = (op: Operation) => op.fail({ errMsg: 'no such file' });
  const lookup = (fd: string) => contents.get(descriptors.get(fd) ?? '');
  const methods = {
    mkdir: (op: Operation) => op.success(),
    readFile(op: Operation) {
      const bytes = contents.get(op.filePath);
      if (bytes) op.success({ data: bytes.slice().buffer });
      else missing(op);
    },
    writeFile(op: Operation) {
      const bytes = new Uint8Array(op.data);
      if (failWrite) {
        failWrite = false;
        contents.set(op.filePath, bytes.slice(0, bytes.length - 1));
        op.fail({ errMsg: 'quota' });
      } else {
        contents.set(op.filePath, bytes.slice());
        op.success();
      }
    },
    open(op: Operation) {
      if (op.flag === 'r' && !contents.has(op.filePath)) return missing(op);
      if (op.flag === 'wx') contents.set(op.filePath, new Uint8Array());
      const fd = String(++sequence);
      descriptors.set(fd, op.filePath);
      op.success({ fd });
    },
    fstat: (op: Operation) => op.success({ stats: { size: lookup(op.fd)?.byteLength } }),
    read(op: Operation) {
      const file = lookup(op.fd);
      if (!file) return missing(op);
      const bytes = file.subarray(op.position, op.position + Math.min(1, op.length));
      new Uint8Array(op.arrayBuffer).set(bytes, op.offset);
      op.success({ arrayBuffer: op.arrayBuffer, bytesRead: bytes.length });
    },
    write(op: Operation) {
      const file = lookup(op.fd);
      const name = descriptors.get(op.fd);
      if (file === undefined || name === undefined) return missing(op);
      const bytes = new Uint8Array(op.data);
      const output = new Uint8Array(op.position + 1);
      output.set(file);
      output.set(bytes.subarray(0, 1), op.position);
      contents.set(name, output);
      op.success({ bytesWritten: 1 });
    },
    close(op: Operation) {
      descriptors.delete(op.fd);
      op.success();
    },
    rename(op: Operation) {
      const bytes = contents.get(op.oldPath);
      if (bytes === undefined) return missing(op);
      contents.set(op.newPath, bytes);
      contents.delete(op.oldPath);
      op.success();
    },
    unlink(op: Operation) {
      if (!contents.delete(op.filePath)) return missing(op);
      op.success();
    },
  };
  return {
    source: { env: { USER_DATA_PATH: 'wxfile://usr' }, getFileSystemManager: () => methods },
    tearNextWrite: () => {
      failWrite = true;
    },
    descriptors,
  };
}

it('reopens native slots and files and retains the last complete record after a torn write', async () => {
  const { source, tearNextWrite, descriptors } = sandbox();
  const records = () => createWechatRecordStore(source, 'sample', 'records');
  const files = () => createWechatFileStore(source, 'sample', 'files');
  await verifyRecordStore(records(), records());
  await verifyFileStore(files(), files());
  const signal = new AbortController().signal;
  (await records().replace('slot', Uint8Array.of(1, 2), signal)).unwrap();
  tearNextWrite();
  expect(await records().replace('slot', Uint8Array.of(3, 4), signal)).toMatchObject({
    error: { code: 'quota' },
  });
  expect((await records().read('slot', signal)).unwrap()).toEqual(Uint8Array.of(1, 2));
  expect(descriptors.size).toBe(0);
});
