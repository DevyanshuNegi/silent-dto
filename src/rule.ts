/**
 * `silent-dto/no-unvalidated-body` — the ESLint form of the check.
 *
 * WHY A LINT RULE AND NOT (ONLY) A CLI
 * ------------------------------------
 * The CLI is a run-once audit: you run it, you feel relieved, you never run it
 * again, and nothing keeps it in the repo. A lint rule runs on every save, every
 * commit and every CI run — and, more to the point, it runs inside the loop a
 * coding agent already performs after editing. Agents do not discover and adopt
 * tools; they do reliably re-run the project's lint and fix what comes back. So
 * the check is placed where the agent trips over it on its own next pass.
 *
 * That is also why `meta.messages` states the remedy rather than the diagnosis
 * (see `erasure.ts`): for an agent the error message *is* the fix mechanism.
 *
 * WHY IT NEEDS NO TYPE INFORMATION
 * --------------------------------
 * The classification is purely syntactic — it never resolves a symbol, so it
 * needs no `parserServices` and no `ts.Program`. It therefore runs at plain-lint
 * speed in every NestJS repo, all of which already run typescript-eslint.
 *
 * The cost of staying syntactic is that a class reached through a type alias
 * (`type Dto = CreateThingDto`) is reported even though it validates fine. That
 * is the deliberate direction to be wrong in: a false positive costs one
 * disable comment, a false negative is an unvalidated production endpoint.
 */

import type { TSESTree } from '@typescript-eslint/utils';
import {
  MESSAGES,
  PIPE_SKIPPED_BUILTINS,
  TYPE_ONLY_UTILITIES,
  type Erasure,
  type MessageId,
} from './erasure';
import type { RuleModule, RuleContext, Fix, Fixer } from './types';

const DOCS_URL =
  'https://github.com/DevyanshuNegi/silent-dto/blob/main/docs/rules/no-unvalidated-body.md';

const MAPPED_TYPE_MODULES = new Set(['@nestjs/mapped-types', '@nestjs/swagger']);

/**
 * Returns why `node` cannot carry validation metadata, or null if it can.
 *
 * Mirrors `classify()` in `scan.ts` node-for-node; `tests/parity.test.mjs`
 * fails if the two ever disagree on a shared fixture.
 */
export function classify(
  node: TSESTree.TypeNode | undefined,
  text: (n: TSESTree.Node) => string,
): Erasure | null {
  if (!node) return { id: 'missingAnnotation', data: {} };

  switch (node.type) {
    case 'TSAnyKeyword':
      return { id: 'erasedKeyword', data: { annotation: 'any' } };
    case 'TSUnknownKeyword':
      return { id: 'erasedKeyword', data: { annotation: 'unknown' } };
    case 'TSObjectKeyword':
      return { id: 'erasedKeyword', data: { annotation: 'object' } };
    case 'TSTypeLiteral':
      return { id: 'erasedTypeLiteral', data: {} };
    case 'TSImportType':
      return {
        id: 'erasedImportType',
        data: {
          annotation: text(node),
          name: importTypeName(node) ?? 'the DTO',
          source: importTypeSource(node) ?? './dto',
        },
      };
    case 'TSUnionType':
      return { id: 'erasedComposite', data: { kind: 'union' } };
    case 'TSIntersectionType':
      return { id: 'erasedComposite', data: { kind: 'intersection' } };
    case 'TSArrayType':
    case 'TSTupleType':
      return { id: 'erasedArrayLike', data: { annotation: text(node) } };
    default:
      break;
  }

  if (node.type === 'TSTypeReference') {
    const name = typeReferenceName(node);
    if (!name) {
      return { id: 'unrecognised', data: { annotation: text(node), kind: node.type } };
    }

    if (name === 'Partial') {
      const inner = soleTypeArgument(node);
      return {
        id: 'erasedPartial',
        data: {
          annotation: text(node),
          name,
          inner: inner ? text(inner) : 'CreateThingDto',
          suggested: inner ? `Partial${text(inner)}` : 'PartialCreateThingDto',
        },
      };
    }
    if (TYPE_ONLY_UTILITIES.has(name)) {
      return { id: 'erasedUtility', data: { annotation: text(node), name } };
    }
    if (PIPE_SKIPPED_BUILTINS.has(name)) {
      return { id: 'skippedBuiltin', data: { name } };
    }
    // A bare class reference. This is the shape that actually validates.
    return null;
  }

  return { id: 'unrecognised', data: { annotation: text(node), kind: node.type } };
}

function typeReferenceName(node: TSESTree.TSTypeReference): string | null {
  const n = node.typeName;
  if (n.type === 'Identifier') return n.name;
  if (n.type === 'TSQualifiedName' && n.right.type === 'Identifier') return n.right.name;
  return null;
}

/** The lone type argument of `Partial<X>`, when there is exactly one. */
function soleTypeArgument(node: TSESTree.TSTypeReference): TSESTree.TypeNode | null {
  const params = node.typeArguments?.params;
  return params && params.length === 1 ? params[0] : null;
}

function importTypeName(node: TSESTree.TSImportType): string | null {
  const q = node.qualifier;
  if (!q) return null;
  if (q.type === 'Identifier') return q.name;
  if (q.type === 'TSQualifiedName' && q.right.type === 'Identifier') return q.right.name;
  return null;
}

/**
 * The module specifier of `import('./x').Y`.
 *
 * typescript-eslint has moved this node's shape across major versions (a bare
 * `Literal` in one, a `TSLiteralType` wrapper in another), so read both rather
 * than pin the plugin to one parser range.
 */
function importTypeSource(node: TSESTree.TSImportType): string | null {
  const arg = node.argument as TSESTree.Node | undefined;
  if (!arg) return null;
  const literal =
    arg.type === 'TSLiteralType' ? (arg.literal as TSESTree.Node) : arg;
  if (literal.type === 'Literal' && typeof literal.value === 'string') {
    return literal.value;
  }
  return null;
}

/** True when the parameter carries a bare `@Body()` — not `@Body('field')`. */
function isWholeBodyParam(decorators: TSESTree.Decorator[] | undefined): boolean {
  return (decorators ?? []).some((dec) => {
    const call = dec.expression;
    if (call.type !== 'CallExpression') return false;
    if (call.callee.type !== 'Identifier') return false;
    if (call.callee.name !== 'Body') return false;
    // `@Body('field')` pulls one property — the pipe is not expected to validate it.
    return call.arguments.length === 0;
  });
}

/**
 * A parameter's decorators and type annotation, normalised across the two shapes
 * a decorated parameter can take: a plain `Identifier`, or a `TSParameterProperty`
 * wrapper when the constructor-property shorthand (`private readonly x: T`) is used.
 */
function unwrapParam(param: TSESTree.Parameter): {
  decorators: TSESTree.Decorator[] | undefined;
  annotated: TSESTree.Node;
  type: TSESTree.TypeNode | undefined;
} {
  const inner =
    param.type === 'TSParameterProperty' ? (param.parameter as TSESTree.Node) : param;
  const decorators = [
    ...((param as { decorators?: TSESTree.Decorator[] }).decorators ?? []),
    ...(param !== inner
      ? ((inner as { decorators?: TSESTree.Decorator[] }).decorators ?? [])
      : []),
  ];
  const typeAnnotation = (inner as { typeAnnotation?: TSESTree.TSTypeAnnotation })
    .typeAnnotation;
  return {
    decorators,
    // Underline the annotation itself where there is one, so the squiggle sits on
    // `Partial<Foo>` rather than on `: Partial<Foo>`; fall back to the parameter
    // name when the annotation is what's missing.
    annotated: typeAnnotation?.typeAnnotation ?? inner,
    type: typeAnnotation?.typeAnnotation,
  };
}

/* ------------------------------------------------------------------ *
 * Suggestions.
 *
 * Deliberately suggestions and not autofixes. Both of these change what
 * the program means — one invents a class, the other adds a binding — so
 * a blind `--fix` sweep is the wrong place for them. As suggestions they
 * still surface as a one-keystroke code action in the editor, and still
 * read as a concrete instruction to an agent.
 * ------------------------------------------------------------------ */

/**
 * Conservative: a declared binding OR any textual occurrence counts as taken, so
 * a suggestion never shadows something the file already relies on.
 *
 * `exclude` must be the annotation being replaced. Without it the check matches
 * the name inside `import('./x').RegisterDto` against itself and every hoist
 * suggestion suppresses itself.
 */
function isNameTaken(
  context: RuleContext,
  name: string,
  exclude?: TSESTree.Node,
): boolean {
  const sourceCode = context.sourceCode;
  const declared = sourceCode.scopeManager?.scopes?.some((scope) =>
    scope.variables.some((v) => v.name === name),
  );
  if (declared) return true;

  const full = sourceCode.getText();
  const rest = exclude
    ? full.slice(0, exclude.range[0]) + full.slice(exclude.range[1])
    : full;
  return new RegExp(`\\b${name}\\b`).test(rest);
}

function topLevelImports(context: RuleContext): TSESTree.ImportDeclaration[] {
  return context.sourceCode.ast.body.filter(
    (n): n is TSESTree.ImportDeclaration => n.type === 'ImportDeclaration',
  );
}

/** Insert `text` as new top-level statements, after the import block if there is one. */
function insertTopLevel(context: RuleContext, fixer: Fixer, text: string): Fix {
  const imports = topLevelImports(context);
  if (imports.length) {
    return fixer.insertTextAfter(imports[imports.length - 1], text);
  }
  const first = context.sourceCode.ast.body[0];
  return first
    ? fixer.insertTextBefore(first, `${text.replace(/^\n+/, '')}\n\n`)
    : fixer.insertTextAfterRange([0, 0], text);
}

function importsBinding(
  decl: TSESTree.ImportDeclaration,
  name: string,
): boolean {
  return decl.specifiers.some(
    (s) => s.type === 'ImportSpecifier' && s.local.name === name,
  );
}

/**
 * `Partial<Foo>` → generate `class PartialFoo extends PartialType(Foo) {}`, import
 * `PartialType` if needed, and point the parameter at the new class.
 *
 * Returns null when the shape isn't simple enough to rewrite safely: a non-trivial
 * type argument, or a name already used in the file.
 */
function suggestMappedType(
  context: RuleContext,
  typeNode: TSESTree.TypeNode,
  data: { inner?: string; suggested?: string },
): ((fixer: Fixer) => Fix[]) | null {
  const { inner, suggested } = data;
  if (!inner || !suggested) return null;
  if (!/^[A-Za-z_$][\w$]*$/.test(inner)) return null;
  if (isNameTaken(context, suggested, typeNode)) return null;

  const hasPartialType = topLevelImports(context).some(
    (d) =>
      MAPPED_TYPE_MODULES.has(String(d.source.value)) &&
      importsBinding(d, 'PartialType'),
  );

  return (fixer: Fixer): Fix[] => {
    let block = '';
    if (!hasPartialType) {
      block += `\nimport { PartialType } from '@nestjs/mapped-types';`;
    }
    block += `\n\nclass ${suggested} extends PartialType(${inner}) {}`;
    return [insertTopLevel(context, fixer, block), fixer.replaceText(typeNode, suggested)];
  };
}

/**
 * `import('./dto/x').Thing` → a real `import { Thing } from './dto/x'` plus a bare
 * reference. This is the one case where the erased form and the working form are
 * exactly equivalent, so the rewrite is mechanical.
 */
function suggestHoistImport(
  context: RuleContext,
  typeNode: TSESTree.TypeNode,
  data: { name?: string; source?: string },
): ((fixer: Fixer) => Fix[]) | null {
  const { name, source } = data;
  if (!name || !source) return null;
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null;

  const imports = topLevelImports(context);
  const fromSource = imports.filter((d) => String(d.source.value) === source);

  // Already imported under this name: only the annotation needs rewriting.
  if (fromSource.some((d) => importsBinding(d, name))) {
    return (fixer) => [fixer.replaceText(typeNode, name)];
  }
  if (isNameTaken(context, name, typeNode)) return null;

  // Prefer extending an existing named import from the same module over adding a
  // second declaration for it.
  const extendable = fromSource.find((d) =>
    d.specifiers.some((s) => s.type === 'ImportSpecifier'),
  );
  if (extendable) {
    const specifiers = extendable.specifiers.filter(
      (s) => s.type === 'ImportSpecifier',
    );
    const last = specifiers[specifiers.length - 1];
    return (fixer) => [
      fixer.insertTextAfter(last, `, ${name}`),
      fixer.replaceText(typeNode, name),
    ];
  }

  return (fixer) => [
    insertTopLevel(context, fixer, `\nimport { ${name} } from '${source}';`),
    fixer.replaceText(typeNode, name),
  ];
}

/* ------------------------------------------------------------------ */

export const noUnvalidatedBody: RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require every whole-body `@Body()` parameter to be annotated with a class, so ValidationPipe actually runs on it',
      url: DOCS_URL,
    },
    hasSuggestions: true,
    schema: [],
    messages: MESSAGES,
  },

  create(context: RuleContext) {
    const text = (n: TSESTree.Node): string => context.sourceCode.getText(n);

    function checkParams(params: TSESTree.Parameter[]): void {
      for (const param of params) {
        const { decorators, annotated, type } = unwrapParam(param);
        if (!isWholeBodyParam(decorators)) continue;

        const erasure = classify(type, text);
        if (!erasure) continue;

        const suggest =
          type && erasure.id === 'erasedPartial'
            ? suggestMappedType(context, type, erasure.data)
            : type && erasure.id === 'erasedImportType'
              ? suggestHoistImport(context, type, erasure.data)
              : null;

        const suggestionId: MessageId | null =
          !suggest ? null : erasure.id === 'erasedPartial' ? 'useMappedType' : 'hoistImportType';

        context.report({
          node: annotated,
          messageId: erasure.id,
          data: erasure.data as Record<string, string>,
          ...(suggest && suggestionId
            ? {
                suggest: [
                  { messageId: suggestionId, data: erasure.data as Record<string, string>, fix: suggest },
                ],
              }
            : {}),
        });
      }
    }

    return {
      MethodDefinition(node: TSESTree.MethodDefinition): void {
        checkParams(node.value.params);
      },
    };
  },
};

export default noUnvalidatedBody;
