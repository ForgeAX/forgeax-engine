import type { BlitzUiInput, UiTextEditor } from '@forgeax/engine-ui-blitz';
import { describe, expect, it, vi } from 'vitest';
import {
  attachWechatKeyboard,
  type WechatKeyboardEvent,
  type WechatKeyboardSource,
} from '../keyboard.js';

function fixture() {
  const listeners = new Set<() => void>();
  const editListeners = new Set<() => void>();
  let editor: UiTextEditor | null = null;
  const ui: BlitzUiInput = {
    pointer: () => false,
    wheel: () => false,
    key: () => false,
    text: vi.fn((value: string) => {
      if (editor) editor = { ...editor, value };
    }),
    commitText: vi.fn(),
    confirm: vi.fn(),
    cancel: () => {
      editor = null;
      for (const listener of listeners) listener();
    },
    focusedText: () => editor,
    ownsInput: () => editor !== null,
    subscribeFocus: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeTextEdit: (listener) => {
      editListeners.add(listener);
      return () => {
        editListeners.delete(listener);
      };
    },
  };
  const callbacks = new Map<string, (event: WechatKeyboardEvent) => void>();
  const source: WechatKeyboardSource = {
    showKeyboard: vi.fn(),
    hideKeyboard: vi.fn(),
    onKeyboardInput: (listener) => {
      callbacks.set('input', listener);
    },
    offKeyboardInput: (listener) => {
      if (callbacks.get('input') === listener) callbacks.delete('input');
    },
    onKeyboardConfirm: (listener) => {
      callbacks.set('confirm', listener);
    },
    offKeyboardConfirm: (listener) => {
      if (callbacks.get('confirm') === listener) callbacks.delete('confirm');
    },
    onKeyboardComplete: (listener) => {
      callbacks.set('complete', listener);
    },
    offKeyboardComplete: (listener) => {
      if (callbacks.get('complete') === listener) callbacks.delete('complete');
    },
  };
  return {
    ui,
    source,
    callbacks,
    listeners,
    editListeners,
    focus(value: string, maxLength = -1, type = 'number') {
      editor = { value, type, multiline: type === 'textarea', maxLength };
      for (const listener of listeners) listener();
    },
    requestEdit() {
      for (const listener of editListeners) listener();
    },
    edit(value: string, maxLength = -1) {
      this.focus(value, maxLength);
      this.requestEdit();
    },
  };
}

describe('native keyboard editor lease', () => {
  it.each([
    ['number', 'text'],
    ['text', 'text'],
    ['textarea', 'text'],
  ] as const)('keeps the complete %s value vocabulary in the native editor', (type, keyboardType) => {
    const f = fixture();
    const release = attachWechatKeyboard(f.ui, f.source, vi.fn());
    f.focus('-0.75', -1, type);
    f.requestEdit();
    expect(f.source.showKeyboard).toHaveBeenCalledWith(
      expect.objectContaining({
        keyboardType,
        defaultValue: '-0.75',
        multiple: type === 'textarea',
      }),
    );
    f.callbacks.get('input')?.({ value: '-3.5' });
    f.callbacks.get('complete')?.({ value: '-3.5' });
    expect(f.ui.focusedText()?.value).toBe('-3.5');
    expect(f.ui.text).toHaveBeenCalledExactlyOnceWith('-3.5');
    release();
  });

  it('keeps focus separate from editing and can reopen the same focused control', () => {
    const f = fixture();
    f.focus('0.42');
    const release = attachWechatKeyboard(f.ui, f.source, vi.fn());
    f.focus('0.5');
    expect(f.source.showKeyboard).not.toHaveBeenCalled();
    f.requestEdit();
    expect(f.source.showKeyboard).toHaveBeenCalledTimes(1);
    const complete = f.callbacks.get('complete');
    complete?.({ value: '0.5' });
    expect(f.ui.focusedText()?.value).toBe('0.5');
    expect(f.callbacks.size).toBe(0);
    expect(f.ui.confirm).not.toHaveBeenCalled();
    f.requestEdit();
    expect(f.source.showKeyboard).toHaveBeenCalledTimes(2);
    complete?.({ value: 'stale' });
    expect(f.ui.text).not.toHaveBeenCalled();
    expect(f.ui.commitText).toHaveBeenCalledTimes(1);
    f.focus('2');
    expect(f.source.hideKeyboard).toHaveBeenCalledTimes(1);
    expect(f.source.showKeyboard).toHaveBeenCalledTimes(2);
    expect(f.callbacks.size).toBe(0);
    release();
    f.requestEdit();
    expect(f.source.showKeyboard).toHaveBeenCalledTimes(2);
    expect(f.listeners.size).toBe(0);
    expect(f.editListeners.size).toBe(0);
  });
  it('projects string edits and confirmation, fences replaced editors and releases subscriptions', () => {
    const f = fixture();
    const errors = vi.fn();
    const release = attachWechatKeyboard(f.ui, f.source, errors);
    expect(f.source.showKeyboard).not.toHaveBeenCalled();
    f.edit('0.5');
    expect(f.source.showKeyboard).toHaveBeenCalledWith(
      expect.objectContaining({ defaultValue: '0.5', multiple: false, maxLength: 2_147_483_647 }),
    );
    const old = f.callbacks.get('input');
    f.callbacks.get('input')?.({ value: '0.75' });
    f.callbacks.get('confirm')?.({ value: '0.75' });
    expect(f.ui.text).toHaveBeenCalledExactlyOnceWith('0.75');
    expect(f.ui.confirm).toHaveBeenCalledTimes(1);
    f.edit('2');
    old?.({ value: 'stale' });
    expect(f.ui.text).toHaveBeenCalledTimes(1);
    f.callbacks.get('complete')?.({ value: '3' });
    expect(f.ui.text).toHaveBeenLastCalledWith('3');
    expect(f.ui.focusedText()?.value).toBe('3');
    expect(f.ui.commitText).toHaveBeenCalledOnce();
    expect(f.callbacks.size).toBe(0);
    f.edit('4');
    const late = [...f.callbacks.values()];
    release();
    release();
    for (const callback of late) callback({ value: 'late' });
    expect(f.ui.text).toHaveBeenCalledTimes(2);
    expect(f.ui.confirm).toHaveBeenCalledTimes(1);
    expect(f.ui.commitText).toHaveBeenCalledTimes(1);
    expect(f.callbacks.size).toBe(0);
    expect(f.listeners.size).toBe(0);
    expect(f.editListeners.size).toBe(0);
    expect(errors).not.toHaveBeenCalled();
  });
  it('opens an unlimited HTML editor with a native limit and preserves untouched long defaults', () => {
    const f = fixture();
    const release = attachWechatKeyboard(f.ui, f.source, vi.fn());
    const value = '1234567890'.repeat(20);
    f.edit(value);
    expect(f.source.showKeyboard).toHaveBeenCalledWith(
      expect.objectContaining({ defaultValue: value, maxLength: 2_147_483_647 }),
    );
    f.callbacks.get('complete')?.({ value });
    expect(f.ui.text).not.toHaveBeenCalled();
    expect(f.ui.focusedText()?.value).toBe(value);
    expect(f.ui.commitText).toHaveBeenCalledOnce();
    release();
  });
  it.each([0, 12, 2_147_483_647])('preserves authored maxlength %i', (maxLength) => {
    const f = fixture();
    const release = attachWechatKeyboard(f.ui, f.source, vi.fn());
    f.edit('2.4', maxLength);
    expect(f.source.showKeyboard).toHaveBeenCalledWith(expect.objectContaining({ maxLength }));
    release();
  });
  it('accepts a deliberately cleared value on native completion', () => {
    const f = fixture();
    const release = attachWechatKeyboard(f.ui, f.source, vi.fn());
    f.edit('2.4');
    f.callbacks.get('complete')?.({ value: '' });
    expect(f.ui.text).toHaveBeenCalledExactlyOnceWith('');
    expect(f.ui.focusedText()?.value).toBe('');
    expect(f.ui.commitText).toHaveBeenCalledOnce();
    release();
  });
  it('retains asynchronous native failure and ignores failure after editor replacement', () => {
    const f = fixture();
    const failures: ((cause: unknown) => void)[] = [];
    f.source.showKeyboard = (options) => {
      failures.push(options.fail);
    };
    const errors = vi.fn();
    const release = attachWechatKeyboard(f.ui, f.source, errors);
    f.edit('1');
    f.edit('2');
    failures[0]?.(new Error('stale'));
    expect(errors).not.toHaveBeenCalled();
    const cause = new Error('keyboard unavailable');
    failures[1]?.(cause);
    expect(errors).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'platform-operation-failed',
        detail: { operation: 'wx.showKeyboard', cause },
      }),
    );
    expect(f.callbacks.size).toBe(0);
    release();
  });
  it('rolls back partial listener acquisition when native registration throws', () => {
    const f = fixture();
    f.source.onKeyboardConfirm = () => {
      throw new Error('native registration failed');
    };
    const errors = vi.fn();
    const release = attachWechatKeyboard(f.ui, f.source, errors);
    f.edit('1');
    expect(errors).toHaveBeenCalledOnce();
    expect(f.callbacks.size).toBe(0);
    release();
  });
  it('releases the focus subscription when acquiring edit requests fails', () => {
    const f = fixture();
    const failure = new Error('edit subscription failed');
    f.ui.subscribeTextEdit = () => {
      throw failure;
    };
    expect(() => attachWechatKeyboard(f.ui, f.source, vi.fn())).toThrow(failure);
    expect(f.listeners.size).toBe(0);
    expect(f.callbacks.size).toBe(0);
  });

  it('releases every editor lease and hides the keyboard when a focus unsubscribe fails', () => {
    const f = fixture();
    const cause = new Error('focus unsubscribe failed');
    const subscribe = f.ui.subscribeFocus;
    f.ui.subscribeFocus = (listener) => {
      const unsubscribe = subscribe(listener);
      return () => {
        unsubscribe();
        throw cause;
      };
    };
    const release = attachWechatKeyboard(f.ui, f.source, vi.fn());
    f.edit('1');
    const late = [...f.callbacks.values()];
    let failure: unknown;
    try {
      release();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'platform-operation-failed',
      detail: { operation: 'release', cause: { errors: [cause] } },
    });
    expect(f.source.hideKeyboard).toHaveBeenCalledTimes(1);
    expect([f.listeners.size, f.editListeners.size, f.callbacks.size]).toEqual([0, 0, 0]);
    for (const callback of late) callback({ value: '2' });
    expect(f.ui.text).not.toHaveBeenCalled();
    expect(f.ui.confirm).not.toHaveBeenCalled();
    expect(f.ui.commitText).not.toHaveBeenCalled();
    expect(() => release()).not.toThrow();
  });
});
