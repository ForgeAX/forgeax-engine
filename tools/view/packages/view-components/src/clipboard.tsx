import { createContext, useContext, useCallback, useState, type ReactNode } from 'react';

const defaultWriteText = async (text: string) => { if (!globalThis.navigator?.clipboard?.writeText) throw new Error('Clipboard write is unavailable in this document'); await navigator.clipboard.writeText(text); };
const ClipboardContext = createContext({writeText: defaultWriteText, reportFailure: (error: unknown) => { console.error(error); }});

export function ClipboardProvider({ writeText = defaultWriteText, children }: { writeText?: (text: string) => Promise<void>; children: ReactNode }) {
  const [failure, setFailure] = useState<string>();
  return <ClipboardContext.Provider value={{writeText, reportFailure: error => setFailure(String(error instanceof Error ? error.message : error))}}>{children}{failure ? <div className="fx-clipboard-error" role="alert">{failure}<button type="button" onClick={() => setFailure(undefined)} aria-label="Dismiss clipboard error">×</button></div> : null}</ClipboardContext.Provider>;
}

export function useClipboard() {
  return useContext(ClipboardContext).writeText;
}

/** UI actions report denied writes and return success for acknowledgment indicators. */
export function useClipboardAction() {
  const {writeText, reportFailure} = useContext(ClipboardContext);
  return useCallback(async (text: string) => {
    try { await writeText(text); return true; }
    catch (error) { reportFailure(error); return false; }
  }, [writeText, reportFailure]);
}
