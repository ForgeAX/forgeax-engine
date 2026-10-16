import { describe, expect, it } from 'vitest';
import { AUDIO_GESTURE_READY_STATES } from '../browser-readiness.mjs';

describe('hello-audio browser gesture readiness', () => {
  it('rejects the static boot placeholder before sending the one real gesture', () => {
    expect(AUDIO_GESTURE_READY_STATES).not.toContain('audio=booting');
    expect(AUDIO_GESTURE_READY_STATES).not.toContain('audio=');
  });

  it('accepts only backend states that have installed or no longer need the resume listener', () => {
    expect(AUDIO_GESTURE_READY_STATES).toEqual(['audio=suspended', 'audio=running']);
  });
});
