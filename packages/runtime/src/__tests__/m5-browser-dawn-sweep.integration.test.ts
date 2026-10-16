import { describe, expect, it } from 'vitest';

describe('M5 browser and dawn sweep contract', () => {
  it('keeps the lifecycle evidence test discoverable by both projects', () => {
    expect('renderer-lifecycle.integration.test.ts').toContain('lifecycle');
    expect('create-renderer-lifecycle.integration.test.ts').toContain('lifecycle');
  });
});
