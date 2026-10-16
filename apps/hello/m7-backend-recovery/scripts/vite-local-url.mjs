import { stripVTControlCharacters } from 'node:util';

export function viteLocalUrl(output) {
  return stripVTControlCharacters(output)
    .match(/Local:\s+(http:\/\/[^\s]+)[^\S\r\n]*\r?\n/)?.[1]
    ?.replace(/\/$/, '');
}
