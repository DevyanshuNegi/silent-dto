/**
 * Plugin entry point.
 *
 * Flat config only. ESLint 10 removed `.eslintrc` support entirely, and the
 * `plugins: ["silent-dto"]` string shorthand — the only thing that ever required
 * an `eslint-plugin-` package name prefix — went with it. Under flat config the
 * plugin is imported as a value, so the package keeps the name the tool is
 * actually called.
 *
 *   // eslint.config.mjs
 *   import silentDto from 'silent-dto';
 *
 *   export default [
 *     silentDto.configs.recommended,
 *   ];
 *
 * or wire the rule yourself:
 *
 *   export default [
 *     {
 *       files: ['**\/*.controller.ts'],
 *       plugins: { 'silent-dto': silentDto },
 *       rules: { 'silent-dto/no-unvalidated-body': 'error' },
 *     },
 *   ];
 */

import { noUnvalidatedBody } from './rule';

type Plugin = {
  meta: { name: string; version: string };
  rules: Record<string, unknown>;
  configs: Record<string, unknown>;
};

const plugin: Plugin = {
  meta: { name: 'silent-dto', version: '0.2.0' },
  rules: { 'no-unvalidated-body': noUnvalidatedBody },
  configs: {},
};

/**
 * Scoped to `*.controller.ts` — the same surface the CLI walks. A bare `@Body()`
 * does not appear anywhere else, so widening this only costs lint time.
 */
plugin.configs.recommended = {
  name: 'silent-dto/recommended',
  files: ['**/*.controller.ts'],
  plugins: { 'silent-dto': plugin },
  rules: { 'silent-dto/no-unvalidated-body': 'error' },
};

/** Same rule, every file — for repos that don't use the `.controller.ts` convention. */
plugin.configs.all = {
  name: 'silent-dto/all',
  plugins: { 'silent-dto': plugin },
  rules: { 'silent-dto/no-unvalidated-body': 'error' },
};

export = plugin;
