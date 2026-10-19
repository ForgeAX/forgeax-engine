/** Blank WGSL line/nested block comments while retaining token, line and source offsets. */
export function stripWgslComments(source: string): string {
  const parts: string[] = [];
  const comments = /\/\/|\/\*/gu;
  const blocks = /\/\*|\*\//gu;
  const lineEnd = /[\r\n]/gu;
  let start = 0;
  for (let comment = comments.exec(source); comment !== null; comment = comments.exec(source)) {
    parts.push(source.slice(start, comment.index));
    if (comment[0] === '//') {
      lineEnd.lastIndex = comments.lastIndex;
      start = lineEnd.exec(source)?.index ?? source.length;
    } else {
      let depth = 1;
      blocks.lastIndex = comments.lastIndex;
      for (let block = blocks.exec(source); block !== null; block = blocks.exec(source)) {
        depth += block[0] === '/*' ? 1 : -1;
        if (depth === 0) break;
      }
      start = depth === 0 ? blocks.lastIndex : source.length;
    }
    parts.push(source.slice(comment.index, start).replace(/[^\r\n]/g, ' '));
    comments.lastIndex = start;
  }
  return parts.length === 0 ? source : parts.join('') + source.slice(start);
}
