import type { ImportDiagnostic } from '@forgeax/engine-types';
import {
  type CssNode,
  generate,
  lexer,
  parse as parseCssTree,
  walk,
} from 'css-tree/dist/csstree.esm';
import type { UiBrowserExtension } from '../browser-extensions.js';
import { sourceRange, type UiAuthoringParse } from './diagnostics.js';
import {
  authoringUrlCategory,
  pickAuthoringCategory,
  UI_AUTHORING_PROFILE,
  type UiAuthoringCategory,
} from './profile.js';

export interface CssAuthoringOptions {
  readonly browserExtensions?: readonly UiBrowserExtension[];
  /** Portable implementation support without the UiAsset companion/scoping policy. */
  readonly portableOnly?: boolean;
  readonly context?: 'stylesheet' | 'declarationList' | 'declaration';
}

/** Parse once; grammar and the implementation profile are independent authorities. */
export function parseCssAuthoring(
  source: string,
  sourcePath: string,
  options: CssAuthoringOptions = {},
): UiAuthoringParse {
  const diagnostics: ImportDiagnostic[] = [];
  const references: UiAuthoringParse['references'][number][] = [];
  const browserCss = options.browserExtensions?.includes('css') ?? false;
  let category: UiAuthoringCategory = browserCss ? 'runtime-bound' : 'native';
  const profile = UI_AUTHORING_PROFILE.css;
  const report = (
    code: string,
    node: CssNode | undefined,
    actual: string,
    expected: string,
    hint: string,
    classification: UiAuthoringCategory = 'runtime-bound',
    severity: 'error' | 'warning' = 'error',
  ) => {
    if (severity === 'error') category = pickAuthoringCategory(category, classification);
    diagnostics.push({
      code,
      severity,
      sourcePath,
      sourceRange: sourceRange(
        source,
        node?.loc?.start.offset ?? 0,
        node?.loc?.end.offset ?? source.length,
      ),
      rule: code,
      expected,
      actual,
      hint,
    });
  };
  const syntaxError = (error: unknown) => {
    const offset =
      typeof error === 'object' &&
      error !== null &&
      'offset' in error &&
      typeof error.offset === 'number'
        ? error.offset
        : 0;
    report(
      'css-syntax-error',
      { type: 'Raw', loc: { start: { offset }, end: { offset: offset + 1 } } },
      error instanceof Error ? error.message : String(error),
      'valid CSS grammar',
      'Fix the CSS token at the reported range.',
    );
  };
  const atRules: string[] = [];
  const reportUnscopedVariable = (node: CssNode, actual: string) =>
    report(
      'unscoped-custom-property',
      node,
      actual,
      '--fx-{package}-* or --forgeax-*',
      'Namespace public custom properties with the package prefix.',
      'native',
      'warning',
    );
  const checkAtRule = (node: CssNode, name: string) => {
    if (!profile.nativeAtRules.includes(name) || (!options.portableOnly && name === 'import')) {
      report(
        'runtime-css-rule',
        node,
        `@${name}`,
        profile.nativeAtRules.map((value) => `@${value}`).join(', '),
        'Replace this at-rule with supported static CSS.',
      );
      return;
    }
    if ((name === 'import' && node.block) || (name !== 'import' && !node.block))
      report(
        'css-syntax-error',
        node,
        generate(node),
        name === 'import' ? 'an @import statement' : `an @${name} block`,
        'Use the required block or statement form for this at-rule.',
      );
    const result = lexer.matchAtrulePrelude(name, node.prelude ?? null);
    if (result.error)
      report(
        'css-invalid-prelude',
        node.prelude ?? node,
        generate(node),
        `valid @${name} grammar`,
        'Correct the at-rule condition or name.',
      );
  };
  const checkClosingDelimiter = (node: CssNode) => {
    if (
      !(node.type === 'Block' || node.type === 'Function' || node.type === 'Parentheses') ||
      !node.loc
    )
      return;
    const expected = node.type === 'Block' ? '}' : ')';
    if (source[node.loc.end.offset - 1] !== expected)
      report(
        'css-syntax-error',
        node,
        generate(node),
        `closing ${expected}`,
        `Close the CSS construct with ${expected}.`,
      );
  };
  const checkDeclarationValue = (
    property: string,
    value: CssNode,
    fontFace: boolean,
    vendor: boolean,
  ) => {
    const result = fontFace
      ? lexer.matchAtruleDescriptor('font-face', property, value)
      : lexer.matchProperty(property, value);
    // css-tree explicitly cannot match var()/env() before cascade. Their
    // tokens and known capability restrictions are still checked below.
    // Vendor declarations follow the receiving browser's fallback rules;
    // their grammar can differ from css-tree's published vendor data.
    if (result.error && !containsCascadeFunction(value) && !vendor)
      report(
        'css-invalid-value',
        value,
        generate(value),
        `valid ${property} value`,
        `Correct the value using the CSS grammar for ${property}.`,
      );
    if (!browserCss || fontFace)
      validateValue(property, value, (entry, reason) =>
        report(
          'unsupported-css-value',
          entry,
          generate(entry),
          `portable ${property} value`,
          reason,
        ),
      );
  };
  const checkDeclaration = (node: CssNode, declared: string, value: CssNode) => {
    if (typeof node.important === 'string')
      report(
        'css-invalid-priority',
        node,
        node.important,
        '!important or no priority',
        'Remove the invalid priority or use !important.',
      );
    const property = declared.toLowerCase();
    const fontFace = atRules.at(-1) === 'font-face';
    const custom = property.startsWith('--');
    const native = fontFace
      ? profile.fontFaceDescriptors.includes(property)
      : profile.nativeProperties.includes(property);
    const browserExtension =
      !fontFace && (browserCss || options.browserExtensions?.some((entry) => entry === property));
    const vendor = browserCss && !fontFace && /^-[a-z]+-/.test(property);
    const known = fontFace || lexer.getProperty(property) !== null;
    if (browserExtension) category = 'runtime-bound';
    if (!custom && ((!native && !browserExtension) || (!known && !vendor))) {
      report(
        known ? 'unsupported-css-property' : 'unknown-css-property',
        node,
        property,
        fontFace
          ? 'a supported @font-face descriptor'
          : 'a portable CSS property in UI_AUTHORING_PROFILE',
        'Run forgeax project check --json and read value.uiAuthoringProfile.css.nativeProperties. For browser-only UI, declare browserExtensions: ["css"] on the UiAsset; otherwise use a supported portable property.',
      );
    } else if (!custom) {
      checkDeclarationValue(property, value, fontFace, vendor);
    }
    if (custom && !options.portableOnly && !isScopedVariable(property))
      reportUnscopedVariable(node, declared);
  };
  const checkUrl = (node: CssNode, url: string) => {
    const range = sourceRange(
      source,
      node.loc?.start.offset ?? 0,
      node.loc?.end.offset ?? source.length,
    );
    references.push({ value: url, range });
    const urlClass = authoringUrlCategory(url);
    if (!options.portableOnly && urlClass !== 'native')
      report(
        urlClass === 'runtime-bound' ? 'runtime-url' : 'root-absolute-url',
        node,
        url,
        'a package-relative companion URL',
        'Use a companion within the UI author directory.',
        urlClass,
      );
  };
  const checkPseudoSelector = (node: CssNode, name: string) => {
    const supported =
      node.type === 'PseudoClassSelector' ? profile.pseudoClasses : profile.pseudoElements;
    // Keyframe selectors use a different grammar and contain no pseudos.
    if (!browserCss && !supported.includes(name))
      report(
        'unsupported-css-selector',
        node,
        generate(node),
        'a portable pseudo selector',
        'Use a selector listed in UI_AUTHORING_PROFILE.css.',
      );
  };
  const checkMediaFeature = (node: CssNode, name: string) => {
    const feature =
      node.type === 'Feature'
        ? name.replace(/^(min|max)-/, '')
        : [node.left, node.middle, node.right].find((entry) => entry?.type === 'Identifier')?.name;
    if (!browserCss && feature && !profile.mediaFeatures.includes(feature))
      report(
        'unsupported-css-media-feature',
        node,
        feature,
        'a host-backed media feature in UI_AUTHORING_PROFILE',
        'Use viewport dimensions, resolution or prefers-reduced-motion; other host preferences have no portable input yet.',
      );
  };
  const checkVarArgument = (node: CssNode) => {
    const variable = node.children && [...node.children][0];
    if (variable?.type !== 'Identifier' || !variable.name?.startsWith('--'))
      report(
        'css-invalid-value',
        node,
        generate(node),
        'var(--custom-property[, fallback])',
        'Pass a custom property name beginning with --.',
      );
  };
  /** UiAsset companion/scoping policy; portable-only parses skip it. */
  const checkAssetScoping = (node: CssNode, name: string) => {
    if (
      (node.type === 'TypeSelector' && ['html', 'body'].includes(name)) ||
      (node.type === 'PseudoClassSelector' && name === 'root')
    )
      report(
        'global-selector',
        node,
        generate(node),
        'a selector scoped to the UI asset',
        'Use :host, a UI class or data-ui-part.',
        'normalizable',
      );
    if (node.type === 'ClassSelector' && /^(?:css|sc|styled)-[a-z\d_-]+$/i.test(name))
      report(
        'generated-class',
        node,
        node.name ?? '',
        'a stable authored class',
        'Replace generated class names with stable authoring selectors.',
        'normalizable',
      );
    if (node.type === 'Function' && name === 'var') {
      const variable = node.children && [...node.children][0];
      if (variable?.name && !isScopedVariable(variable.name))
        reportUnscopedVariable(variable, variable.name);
    }
  };
  try {
    const parseErrors: unknown[] = [];
    let tree = parseCssTree(source, {
      context: options.context ?? 'stylesheet',
      positions: true,
      parseCustomProperty: true,
      onParseError: (error) => parseErrors.push(error),
      onComment: (value, loc) => {
        if (!options.portableOnly && /styled-components|emotion|css-in-js/i.test(value))
          report(
            'runtime-css-in-js',
            { type: 'Comment', loc },
            value,
            'static authored CSS',
            'Emit static CSS before importing the UI.',
          );
      },
    });
    // The historical public helper accepts a bare declaration list too. Select
    // that grammar only when the stylesheet parser produced no rules at all.
    if (
      !options.context &&
      tree.children &&
      [...tree.children].length > 0 &&
      [...tree.children].every((node) => node.type === 'Raw')
    ) {
      parseErrors.length = 0;
      tree = parseCssTree(source, {
        context: 'declarationList',
        positions: true,
        parseCustomProperty: true,
        onParseError: (error) => parseErrors.push(error),
      });
    }
    parseErrors.forEach(syntaxError);
    walk(tree, {
      enter(node) {
        const name = typeof node.name === 'string' ? node.name.toLowerCase() : '';
        if (node.type === 'Atrule') {
          atRules.push(name);
          checkAtRule(node, name);
        }
        checkClosingDelimiter(node);
        if (node.type === 'Declaration' && node.property && typeof node.value === 'object')
          checkDeclaration(node, node.property, node.value);
        if (node.type === 'Url' && typeof node.value === 'string' && !node.value.startsWith('#'))
          checkUrl(node, node.value);
        if (node.type === 'PseudoClassSelector' || node.type === 'PseudoElementSelector')
          checkPseudoSelector(node, name);
        if (node.kind === 'media' && (node.type === 'Feature' || node.type === 'FeatureRange'))
          checkMediaFeature(node, name);
        if (node.type === 'Function' && name === 'var') checkVarArgument(node);
        if (!options.portableOnly) checkAssetScoping(node, name);
      },
      leave(node) {
        if (node.type === 'Atrule') atRules.pop();
      },
    });
  } catch (error) {
    syntaxError(error);
  }
  return { sourcePath, source, category, diagnostics, references };
}

function validateValue(
  property: string,
  value: CssNode,
  reject: (node: CssNode, hint: string) => void,
): void {
  const keywords = UI_AUTHORING_PROFILE.css.unsupportedKeywords[property] ?? [];
  walk(value, (node) => {
    const name = typeof node.name === 'string' ? node.name.toLowerCase() : '';
    if (node.type === 'Identifier' && keywords.includes(name))
      reject(node, `Replace ${name}; its native layout or paint implementation is incomplete.`);
    if (property === 'clip-path' && node.type === 'Url')
      reject(
        node,
        'Use an inline circle(), ellipse(), polygon(), inset() without round, or path(); URL clipping is not implemented.',
      );
    if (property === 'src' && node.type === 'Function' && name === 'local')
      reject(node, 'Publish font bytes with url(); native UI does not discover machine fonts.');
    if (
      property === 'content' &&
      (node.type === 'Function' || node.type === 'Url') &&
      !['var', 'env'].includes(name)
    )
      reject(
        node,
        'Use literal generated text; counters, attribute substitution and generated images are not implemented.',
      );
    if (property === 'transform' && node.type === 'Function') {
      const coordinates = node.children
        ? [...node.children].filter((child) => child.type !== 'Operator')
        : [];
      const nonPlanar =
        name === 'perspective' ||
        (name === 'translate3d' && !constant(coordinates[2], 0)) ||
        (name === 'scale3d' && !constant(coordinates[2], 1)) ||
        (name === 'rotate3d' && !(constant(coordinates[0], 0) && constant(coordinates[1], 0))) ||
        (['translatez', 'rotatex', 'rotatey'].includes(name) && !constant(coordinates[0], 0)) ||
        (name === 'scalez' && !constant(coordinates[0], 1)) ||
        (name === 'matrix3d' &&
          (![2, 3, 6, 7, 8, 9, 11, 14].every((index) => constant(coordinates[index], 0)) ||
            ![10, 15].every((index) => constant(coordinates[index], 1))));
      if (nonPlanar)
        reject(
          node,
          'Use a planar transform; native painting does not project 3D transforms. Express variable transforms with two-dimensional functions.',
        );
    }
    if (
      ['translate', 'scale', 'transform-origin'].includes(property) &&
      node === value &&
      node.children
    ) {
      const coordinates = [...node.children];
      if (coordinates.length > 2 && !constant(coordinates[2], property === 'scale' ? 1 : 0))
        reject(node, 'Use planar coordinates (z = 0 for position, z = 1 for scale).');
    }
    if (property === 'rotate' && node === value && node.children) {
      const coordinates = [...node.children];
      if (
        coordinates.length > 1 &&
        coordinates[0]?.name !== 'z' &&
        !(constant(coordinates[0], 0) && constant(coordinates[1], 0))
      )
        reject(node, 'Use one rotation angle or the z axis.');
    }
  });
  if (property === 'filter') {
    const functions = value.children
      ? [...value.children].filter((node) => node.type === 'Function')
      : [];
    if (functions.length > 1)
      reject(
        value,
        'Use at most one filter function; the current CPU painter supports one filter node.',
      );
    walk(value, (node) => {
      if (node.type === 'Url')
        reject(node, 'Use a built-in filter; SVG URL filters are not implemented.');
      // Drop-shadow without an explicit color currently resolves currentColor to black.
      if (node.type === 'Function' && node.name?.toLowerCase() === 'drop-shadow') {
        const children = node.children ? [...node.children] : [];
        const explicitColor = children.some(
          (child) =>
            child.type === 'Hash' ||
            (child.type === 'Identifier' && child.name?.toLowerCase() !== 'currentcolor') ||
            (child.type === 'Function' &&
              !['var', 'env', 'calc', 'min', 'max', 'clamp'].includes(
                child.name?.toLowerCase() ?? '',
              )),
        );
        if (!explicitColor)
          reject(
            node,
            'Give drop-shadow an explicit color; native currentColor resolution is incomplete.',
          );
      }
    });
  }
}

function constant(node: CssNode | undefined, expected: number): boolean {
  return (
    (node?.type === 'Number' || node?.type === 'Dimension') &&
    typeof node.value === 'string' &&
    Number(node.value) === expected
  );
}

function isScopedVariable(name: string): boolean {
  const profile = UI_AUTHORING_PROFILE.css;
  return (
    name.startsWith(profile.packageVariablePrefix) || name.startsWith(profile.engineVariablePrefix)
  );
}

/** css-tree cannot match var()/env() before cascade. */
function containsCascadeFunction(value: CssNode): boolean {
  let deferred = false;
  walk(value, (entry) => {
    if (entry.type === 'Function' && ['var', 'env'].includes(entry.name?.toLowerCase() ?? ''))
      deferred = true;
  });
  return deferred;
}
