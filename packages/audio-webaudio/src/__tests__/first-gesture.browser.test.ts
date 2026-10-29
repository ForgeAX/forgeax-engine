import { expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { WebAudioEngine } from '../web-audio-engine';

it('creates and resumes lazy Host audio on the first gesture before any clip arrives', async () => {
  const engine = new WebAudioEngine();
  const button = document.createElement('button');
  button.textContent = 'Start audio';
  document.body.append(button);
  try {
    expect(engine.getState().contextState).toBe('suspended');
    await userEvent.click(button);
    await expect.poll(() => engine.getState().contextState).toBe('running');
    expect(engine.getActiveSourceCount()).toBe(0);
  } finally {
    engine.destroy();
    button.remove();
  }
});
