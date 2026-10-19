import type { ImportDiagnostic } from '@forgeax/engine-types';
import {
  type DefaultTreeAdapterTypes,
  defaultTreeAdapter,
  html as htmlNames,
  Parser,
  type ParserOptions,
  type Token,
} from 'parse5';
import type { UiBrowserExtension } from '../browser-extensions.js';
import { parseCssAuthoring } from './css.js';
import { sourceRange, type UiAuthoringParse } from './diagnostics.js';
import {
  authoringUrlCategory,
  pickAuthoringCategory,
  UI_AUTHORING_PROFILE,
  type UiAuthoringCategory,
} from './profile.js';

type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;

const voidElements = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
const allowedHookNames = new Set(UI_AUTHORING_PROFILE.html.hooks);
const urlAttributes = new Set(UI_AUTHORING_PROFILE.html.urlAttributes);

function locationFor(source: string, node: Element): ReturnType<typeof sourceRange> {
  const location = node.sourceCodeLocation;
  if (location && 'startTag' in location && location.startTag !== undefined) {
    return sourceRange(source, location.startTag.startOffset, location.startTag.endOffset);
  }
  if (location && 'startOffset' in location)
    return sourceRange(source, location.startOffset, location.endOffset);
  return sourceRange(source, 0);
}

function attributeOffset(
  source: string,
  node: Element,
  name: string,
): ReturnType<typeof sourceRange> {
  const location = node.sourceCodeLocation;
  const attr = location && 'attrs' in location ? location.attrs?.[name] : undefined;
  if (attr) return sourceRange(source, attr.startOffset, attr.endOffset);
  return locationFor(source, node);
}

function rangeOfValue(
  source: string,
  node: Element,
  name: string,
  value: string,
): ReturnType<typeof sourceRange> {
  const attrRange = attributeOffset(source, node, name);
  const offset = source.indexOf(value, attrRange.start);
  return offset < 0 ? attrRange : sourceRange(source, offset, offset + Math.max(value.length, 1));
}

function walk(node: ParentNode, visit: (element: Element) => void): void {
  for (const child of node.childNodes) {
    if (child.nodeName !== '#text' && child.nodeName !== '#comment' && 'tagName' in child) {
      visit(child as Element);
      walk(child as ParentNode, visit);
      if ('content' in child) walk(child.content as ParentNode, visit);
    }
  }
}

export interface HtmlAuthoringOptions {
  readonly browserExtensions?: readonly UiBrowserExtension[];
  /** Capability/syntax validation for host documents and dynamic DOM mutations. */
  readonly portableOnly?: boolean;
  readonly context?: 'fragment' | 'document';
  /** The receiving element for DOM innerHTML, including table parsing contexts. */
  readonly contextElement?: string;
}

// HTML permits these end tags to be omitted. All other implicit closes in the
// parse5 tree are recoveries, and are reported at the original opening tag.
const optionalEndTags = new Set([
  'html',
  'head',
  'body',
  'p',
  'li',
  'dt',
  'dd',
  'rt',
  'rp',
  'optgroup',
  'option',
  'colgroup',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
]);

export function parseHtmlAuthoring(
  source: string,
  sourcePath: string,
  options: HtmlAuthoringOptions = {},
): UiAuthoringParse {
  const diagnostics: ImportDiagnostic[] = [];
  const references: UiAuthoringParse['references'][number][] = [];
  let category: UiAuthoringCategory = 'native';
  const parts = new Set<string>();
  let inputWithoutLabel: Element | undefined;
  let hasLabel = false;
  const parserOptions: ParserOptions<DefaultTreeAdapterTypes.DefaultTreeAdapterMap> = {
    sourceCodeLocationInfo: true,
    onParseError(error) {
      if (error.code === 'missing-doctype') return;
      category = 'runtime-bound';
      diagnostics.push({
        code: 'html-syntax-error',
        severity: 'error',
        sourcePath,
        sourceRange: sourceRange(source, error.startOffset, error.endOffset),
        rule: 'html-grammar',
        expected: 'valid HTML grammar',
        actual: error.code,
        hint: 'Correct the HTML token at the reported source range.',
      });
    },
  };
  const parser =
    options.context === 'document'
      ? new Parser(parserOptions)
      : Parser.getFragmentParser(
          options.contextElement
            ? defaultTreeAdapter.createElement(options.contextElement, htmlNames.NS.HTML, [])
            : undefined,
          parserOptions,
        );
  // Observe the same tokenizer the tree builder drives, so comments, raw text,
  // optional end tags and foreign content keep HTML semantics. Tokens dropped
  // by recovery still get a source diagnostic instead of disappearing.
  const tags: Token.TagToken[] = [];
  const onStartTag = parser.onStartTag.bind(parser);
  const onEndTag = parser.onEndTag.bind(parser);
  parser.onStartTag = (token) => {
    tags.push(token);
    onStartTag(token);
  };
  parser.onEndTag = (token) => {
    tags.push(token);
    onEndTag(token);
  };
  parser.tokenizer.write(source, true);
  const fragment = options.context === 'document' ? parser.document : parser.getFragment();
  const acceptedTags = new Set<number>();
  walk(fragment, (element) => {
    const tag = element.tagName.toLowerCase();
    const elementRange = locationFor(source, element);
    if (tag === 'label') hasLabel = true;
    const location = element.sourceCodeLocation;
    if (location?.startTag) acceptedTags.add(location.startTag.startOffset);
    if (location?.endTag) acceptedTags.add(location.endTag.startOffset);
    if (
      location?.startTag &&
      !location.endTag &&
      !voidElements.has(tag) &&
      !optionalEndTags.has(tag)
    ) {
      category = 'runtime-bound';
      diagnostics.push({
        code: 'html-unclosed-tag',
        severity: 'error',
        sourcePath,
        sourceRange: elementRange,
        rule: 'html-grammar',
        expected: `closing </${tag}>`,
        actual: 'implicit parser recovery',
        hint: `Close <${tag}> before its parent or the end of the source.`,
      });
    }
    if (
      !UI_AUTHORING_PROFILE.html.nativeElements.includes(tag) &&
      !(options.portableOnly && UI_AUTHORING_PROFILE.html.documentElements.includes(tag))
    ) {
      category = 'runtime-bound';
      diagnostics.push({
        code: 'runtime-html-surface',
        severity: 'error',
        sourcePath,
        sourceRange: elementRange,
        rule: 'html-native-elements',
        expected: 'a supported semantic HTML element',
        actual: `<${tag}>`,
        hint: 'Move executable or custom runtime markup into a framework island.',
      });
    }
    if (
      !options.portableOnly &&
      tag === 'template' &&
      !element.attrs.some(
        (attr) => attr.name === 'data-ui-template' && attr.value.trim().length > 0,
      )
    ) {
      category = 'runtime-bound';
      diagnostics.push({
        code: 'invalid-template',
        severity: 'error',
        sourcePath,
        sourceRange: elementRange,
        rule: 'html-template-hook',
        expected: 'template[data-ui-template] with a non-empty name',
        actual: '<template>',
        hint: 'Name templates with data-ui-template so the consumer can clone them explicitly.',
      });
    }
    for (const attr of element.attrs) {
      const name = attr.name.toLowerCase();
      const value = attr.value;
      const range = attributeOffset(source, element, attr.name);
      if (name.startsWith('on')) {
        category = 'runtime-bound';
        diagnostics.push({
          code: 'runtime-event-handler',
          severity: 'error',
          sourcePath,
          sourceRange: range,
          rule: 'html-event-handlers',
          expected: 'data-ui-action with a consumer-side listener',
          actual: name,
          hint: 'Remove inline event handlers and bind behavior from the framework island.',
        });
      } else if (name === 'style' && !options.portableOnly) {
        category = category === 'runtime-bound' ? category : 'normalizable';
        diagnostics.push({
          code: 'inline-style',
          severity: 'error',
          sourcePath,
          sourceRange: range,
          rule: 'html-inline-style',
          expected: 'stylesheet-owned declarations',
          actual: value,
          hint: 'Move inline declarations to the companion CSS source.',
        });
      } else if (
        !options.portableOnly &&
        (name.startsWith('data-ui-') || name === 'data-framework-island')
      ) {
        if (!allowedHookNames.has(name) || value.trim().length === 0) {
          category = 'runtime-bound';
          diagnostics.push({
            code: 'invalid-ui-hook',
            severity: 'error',
            sourcePath,
            sourceRange: range,
            rule: 'html-ui-hooks',
            expected: 'a supported non-empty ForgeaX UI hook',
            actual: `${name}=${value}`,
            hint: 'Use data-ui-part, data-ui-action, data-ui-template, or data-framework-island with a non-empty value.',
          });
        }
        if (name === 'data-ui-part' && value.trim().length > 0) {
          if (parts.has(value))
            diagnostics.push({
              code: 'duplicate-ui-part',
              severity: 'warning',
              sourcePath,
              sourceRange: range,
              rule: 'html-ui-part-unique',
              expected: 'one element per data-ui-part value',
              actual: value,
              hint: 'Rename one part so scenario selectors remain unambiguous.',
            });
          parts.add(value);
        }
      } else if (urlAttributes.has(name) && value.length > 0) {
        const urlClass = authoringUrlCategory(value);
        if (!options.portableOnly && urlClass !== 'native') {
          category = pickAuthoringCategory(category, urlClass);
          diagnostics.push({
            code: urlClass === 'runtime-bound' ? 'runtime-url' : 'root-absolute-url',
            severity: 'error',
            sourcePath,
            sourceRange: rangeOfValue(source, element, attr.name, value),
            rule: 'html-companion-url',
            expected: 'a package-relative companion or #fragment URL',
            actual: value,
            hint:
              urlClass === 'runtime-bound'
                ? 'Use a package-relative companion URL.'
                : 'Remove the leading root or parent traversal from the URL.',
          });
        }
        if (!value.startsWith('#'))
          references.push({ value, range: rangeOfValue(source, element, attr.name, value) });
      }
      if (
        tag === 'select' &&
        (name === 'multiple' || (name === 'size' && Number.parseInt(value, 10) > 1))
      ) {
        category = 'runtime-bound';
        diagnostics.push({
          code: 'unsupported-select-mode',
          severity: 'error',
          sourcePath,
          sourceRange: range,
          rule: 'html-select-mode',
          expected: 'a single-selection dropdown',
          actual: `${name}=${value}`,
          hint: 'Use a single-selection select. Native multiple-selection listboxes are not implemented.',
        });
      }
      if (
        tag === 'input' &&
        name === 'type' &&
        value &&
        !UI_AUTHORING_PROFILE.html.inputTypes.includes(value.toLowerCase())
      ) {
        category = 'runtime-bound';
        diagnostics.push({
          code: 'unsupported-input-type',
          severity: 'error',
          sourcePath,
          sourceRange: range,
          rule: 'html-input-type',
          expected: UI_AUTHORING_PROFILE.html.inputTypes.join(', '),
          actual: value,
          hint: 'Use a supported control; native pickers require a qualified host implementation.',
        });
      }
      if (name === 'srcset' || name === 'is' || name.startsWith('shadowroot')) {
        category = 'runtime-bound';
        diagnostics.push({
          code: 'unsupported-html-attribute',
          severity: 'error',
          sourcePath,
          sourceRange: range,
          rule: 'html-native-attributes',
          expected: 'a portable element attribute',
          actual: name,
          hint: 'Use a single src, ordinary elements and explicit attachShadow({ mode: "open" }).',
        });
      }
      if (name === 'style') {
        const css = parseCssAuthoring(value, sourcePath, {
          browserExtensions: options.browserExtensions ?? [],
          portableOnly: true,
          context: 'declarationList',
        });
        for (const diagnostic of css.diagnostics)
          diagnostics.push({ ...diagnostic, sourceRange: range });
        if (css.category === 'runtime-bound') category = 'runtime-bound';
      }
    }
    if (tag === 'style') {
      const text = element.childNodes.filter(
        (node): node is DefaultTreeAdapterTypes.TextNode =>
          node.nodeName === '#text' && 'value' in node,
      );
      const cssSource = text.map((node) => node.value).join('');
      const offset = text[0]?.sourceCodeLocation?.startOffset ?? location?.startTag?.endOffset ?? 0;
      const css = parseCssAuthoring(cssSource, sourcePath, {
        browserExtensions: options.browserExtensions ?? [],
        portableOnly: options.portableOnly ?? false,
      });
      for (const diagnostic of css.diagnostics)
        diagnostics.push({
          ...diagnostic,
          sourceRange: sourceRange(
            source,
            offset + diagnostic.sourceRange.start,
            offset + diagnostic.sourceRange.end,
          ),
        });
      if (css.category === 'runtime-bound') category = 'runtime-bound';
    }
    if (
      !options.portableOnly &&
      tag === 'input' &&
      !element.attrs.some((attr) => attr.name === 'aria-label' || attr.name === 'aria-labelledby')
    )
      inputWithoutLabel = element;
  });
  for (const token of tags) {
    if (!token.location || acceptedTags.has(token.location.startOffset)) continue;
    category = 'runtime-bound';
    diagnostics.push({
      code: 'html-ignored-tag',
      severity: 'error',
      sourcePath,
      sourceRange: sourceRange(source, token.location.startOffset, token.location.endOffset),
      rule: 'html-grammar-recovery',
      expected: 'a tag admitted by the HTML tree builder',
      actual: token.tagName,
      hint: 'Remove the stray tag or place it in the correct HTML parent/context.',
    });
  }
  if (inputWithoutLabel && !hasLabel) {
    diagnostics.push({
      code: 'missing-accessible-label',
      severity: 'warning',
      sourcePath,
      sourceRange: locationFor(source, inputWithoutLabel),
      rule: 'html-accessible-label',
      expected: 'label, aria-label, or aria-labelledby',
      actual: inputWithoutLabel.tagName,
      hint: 'Associate the control with an accessible label.',
    });
  }
  return { sourcePath, source, category, diagnostics, references };
}
