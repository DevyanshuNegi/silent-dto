/**
 * The shipped flat configs, exercised through the real `ESLint` class rather
 * than the Linter — this is the path a consumer's `eslint.config.mjs` takes,
 * and it is where a wrong plugin key or `files` glob would actually show up.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ESLint } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import plugin from '../dist/index.js';

const CODE = `import { Body, Patch } from '@nestjs/common';

class ThingController {
  @Patch()
  update(@Body() dto: Partial<CreateThingDto>) {}
}
`;

/** What a NestJS repo already has in place: a TS parser for TS files. */
const PARSER_BASE = {
  files: ['**/*.ts'],
  languageOptions: { parser: tsParser, ecmaVersion: 2022, sourceType: 'module' },
};

function eslintWith(config) {
  return new ESLint({
    cwd: process.cwd(),
    overrideConfigFile: true,
    overrideConfig: [PARSER_BASE, config],
  });
}

async function messagesFor(config, filePath) {
  const results = await eslintWith(config).lintText(CODE, { filePath });
  return results[0].messages;
}

test('configs.recommended flags an erased @Body() in a controller', async () => {
  const messages = await messagesFor(plugin.configs.recommended, 'src/thing.controller.ts');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].ruleId, 'silent-dto/no-unvalidated-body');
  assert.equal(messages[0].messageId, 'erasedPartial');
  assert.equal(messages[0].severity, 2);
});

test('configs.recommended is scoped to *.controller.ts', async () => {
  const messages = await messagesFor(plugin.configs.recommended, 'src/thing.service.ts');
  assert.deepEqual(messages, []);
});

test('configs.all applies the rule regardless of filename', async () => {
  const messages = await messagesFor(plugin.configs.all, 'src/thing.service.ts');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].ruleId, 'silent-dto/no-unvalidated-body');
});

test('the suggestion is offered to editors, and is not a blind autofix', async () => {
  const messages = await messagesFor(plugin.configs.recommended, 'src/thing.controller.ts');
  assert.equal(messages[0].fix, undefined, 'must not autofix — it invents a class');
  assert.equal(messages[0].suggestions.length, 1);
  assert.match(messages[0].suggestions[0].desc, /PartialType\(CreateThingDto\)/);
});

test('--fix leaves the code untouched', async () => {
  const results = await new ESLint({
    overrideConfigFile: true,
    overrideConfig: [PARSER_BASE, plugin.configs.recommended],
    fix: true,
  }).lintText(CODE, { filePath: 'src/thing.controller.ts' });
  assert.equal(results[0].output, undefined);
});

test('plugin metadata is present, so ESLint can name the rule source', () => {
  assert.equal(plugin.meta.name, 'silent-dto');
  assert.match(plugin.meta.version, /^\d+\.\d+\.\d+$/);
  assert.ok(plugin.rules['no-unvalidated-body']);
});
