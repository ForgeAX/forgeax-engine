export function temporaryDirectories(): {
  make(prefix: string): Promise<string>;
  clear(): Promise<void>;
};
