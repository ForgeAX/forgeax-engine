import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { tags } from '@lezer/highlight';

const keywords = new Set(
  'alias break case const const_assert continue continuing default diagnostic discard else enable false fn for if let loop override requires return struct switch true var while'.split(
    ' ',
  ),
);
const types = new Set(
  'bool f16 f32 i32 u32 vec2f vec3f vec4f vec2i vec3i vec4i vec2u vec3u vec4u mat2x2f mat3x3f mat4x4f array atomic ptr sampler sampler_comparison texture_2d texture_2d_array texture_3d texture_cube'.split(
    ' ',
  ),
);
const builtins = new Set(
  'abs acos asin atan atan2 ceil clamp cos cross degrees distance dot exp floor fract length max min mix normalize pow radians reflect refract round sign sin smoothstep sqrt step tan textureDimensions textureLoad textureSample textureStore'.split(
    ' ',
  ),
);

export const wgslLanguage = StreamLanguage.define({
  startState: () => ({}),
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match('//')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.peek() === '"') {
      stream.next();
      while (stream.peek() !== undefined && stream.next() !== '"') {
        // Consume escaped characters as part of the same string token.
        if (stream.current().endsWith('\\')) stream.next();
      }
      return 'string';
    }
    if (stream.peek() === '@') {
      stream.next();
      stream.match(/[A-Za-z_][\w]*/, true);
      return 'keyword';
    }
    if (stream.match(/(?:0[xX][0-9a-fA-F_]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[uifh]?|\.\d+)/, true))
      return 'number';
    if (stream.match(/[A-Za-z_][\w]*/, true)) {
      const word = stream.current();
      if (keywords.has(word)) return 'keyword';
      if (types.has(word)) return 'typeName';
      if (builtins.has(word)) return 'builtin';
      return 'variableName';
    }
    stream.next();
    return /[+\-*/%&|^~!=<>?:;,()[\]{}]/.test(stream.current()) ? 'operator' : null;
  },
});

export const wgslHighlighting: Extension = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.keyword, color: '#c678dd' },
    { tag: tags.typeName, color: '#e5c07b' },
    { tag: tags.variableName, color: '#abb2bf' },
    { tag: tags.comment, color: '#5c6370', fontStyle: 'italic' },
    { tag: tags.string, color: '#98c379' },
    { tag: tags.number, color: '#d19a66' },
    { tag: tags.operator, color: '#56b6c2' },
    { tag: tags.function(tags.variableName), color: '#61afef' },
  ]),
);
