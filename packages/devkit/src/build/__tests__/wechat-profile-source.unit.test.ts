import { expect, it } from 'vitest';
import type { ProjectFacts } from '../../types.js';
import { wechatHostSource } from '../wechat.js';

it('adds bounded CPU profiling only to an explicit WeChat diagnostic build', () => {
  const facts = { name: 'Game' } as ProjectFacts;
  const ordinary = wechatHostSource(facts, '/native');
  const diagnostic = wechatHostSource(facts, '/native', false, {}, true);
  const frameTrace = wechatHostSource(facts, '/native', false, {}, false, true);

  expect(ordinary).not.toContain('profileStart');
  expect(ordinary).not.toContain('frameReceiptTraceStart');
  expect(diagnostic).toContain("import { createProfiler } from '@forgeax/engine/profiler'");
  expect(diagnostic).toContain('frameLimit: 180, eventLimit: 16384');
  expect(diagnostic).toContain(
    'profileState: () => ({ activeCaptureId: profiler.activeCaptureId()',
  );
  expect(diagnostic).toContain('execution: app?.execution.report()');
  expect(diagnostic.match(/\n {4}profiler,\n/g)).toHaveLength(2);
  expect(frameTrace).not.toContain("import { createProfiler } from '@forgeax/engine/profiler'");
  expect(frameTrace).toContain('frameReceiptTraceStart');
  expect(frameTrace).toContain('frameReceiptTraceState: frameTraceState');
  expect(frameTrace).toContain('frameLimit: 600');
  expect(frameTrace).toContain("completionSilenceMs > 1000 ? 'stalled' : 'capturing'");
  expect(frameTrace).toContain('frameReceiptTraceStop');
  expect(frameTrace).toContain("capture.stopReason = 'operator'");
  expect(frameTrace).not.toContain("phase !== 'ready' || game === undefined");
  expect(frameTrace).toContain('recordFrameSubmission(detail)');
  expect(frameTrace).toContain('submitToCompletionMs');
});
