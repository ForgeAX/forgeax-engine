export function testGate(): {
  promise: Promise<void>;
  resolve(): void;
  reject(reason?: unknown): void;
};
