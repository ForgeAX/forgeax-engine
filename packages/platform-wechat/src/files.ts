export interface WechatTextSource {
  getFileSystemManager(): {
    readFile(options: {
      readonly filePath: string;
      readonly encoding: 'utf8';
      readonly success: (result: { readonly data: string }) => void;
      readonly fail: (cause: unknown) => void;
    }): void;
  };
}

/** Native UTF-8 file reader for ShaderRegistry and other owner-defined text inputs. */
export function createWechatTextReader(
  source: WechatTextSource,
): (path: string) => Promise<string> {
  return (path) =>
    new Promise((resolve, reject) => {
      source.getFileSystemManager().readFile({
        filePath: path,
        encoding: 'utf8',
        success: ({ data }) =>
          typeof data === 'string'
            ? resolve(data)
            : reject(new TypeError('WeChat readFile did not return UTF-8 text')),
        fail: reject,
      });
    });
}
