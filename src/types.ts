/**
 * Minimal structural types for the slice of the ESLint rule API this plugin uses.
 *
 * Hand-rolled rather than imported from `@typescript-eslint/utils` so that
 * `@typescript-eslint/utils` stays a devDependency: a plugin that ships one rule
 * should not drag a resolver-sized package into every consumer's install tree.
 * The rule is still fully type-checked against these — they are narrower than the
 * real API, not looser.
 */

import type { TSESTree } from '@typescript-eslint/utils';

export type Fix = { range: readonly [number, number]; text: string };

export type Fixer = {
  insertTextAfter(node: TSESTree.Node, text: string): Fix;
  insertTextBefore(node: TSESTree.Node, text: string): Fix;
  insertTextAfterRange(range: readonly [number, number], text: string): Fix;
  replaceText(node: TSESTree.Node, text: string): Fix;
};

export type Suggestion = {
  messageId: string;
  data?: Record<string, string>;
  fix(fixer: Fixer): Fix[];
};

export type ReportDescriptor = {
  node: TSESTree.Node;
  messageId: string;
  data?: Record<string, string>;
  suggest?: Suggestion[];
};

export type SourceCode = {
  ast: TSESTree.Program;
  getText(node?: TSESTree.Node): string;
  scopeManager?: { scopes?: Array<{ variables: Array<{ name: string }> }> } | null;
};

export type RuleContext = {
  sourceCode: SourceCode;
  report(descriptor: ReportDescriptor): void;
};

export type RuleModule = {
  meta: {
    type: 'problem' | 'suggestion' | 'layout';
    docs: { description: string; url?: string };
    hasSuggestions?: boolean;
    fixable?: 'code' | 'whitespace';
    schema: unknown[];
    messages: Readonly<Record<string, string>>;
  };
  create(context: RuleContext): Record<string, (node: never) => void>;
};
