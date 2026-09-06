/**
 * The CLI and the ESLint rule must reach the same verdict on the same source.
 *
 * They walk different ASTs — the TypeScript compiler's own vs TSESTree — and it
 * would be easy for one to gain a case the other lacks. The README's claim is
 * that this is *one* rule with two front ends, so that claim gets a test: every
 * shape below goes through both, and the sequence of verdict ids must be equal.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Linter } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import plugin from '../dist/index.js';
import { scanFile } from '../dist/scan.js';

/**
 * One handler per shape. Order matters: both front ends report in source order,
 * so the assertion is on the sequence, not just the set.
 */
const FIXTURE = `import { Body, Param, Patch, Post, Query } from '@nestjs/common';
import { CreateThingDto } from './dto/create-thing.dto';

class ThingController {
  @Post()
  valid(@Body() dto: CreateThingDto) {}

  @Post()
  validField(@Body('reason') reason: string) {}

  @Post()
  validOtherDecorator(@Query() q: any, @Param('id') id: string) {}

  @Post()
  anyKeyword(@Body() dto: any) {}

  @Post()
  unknownKeyword(@Body() dto: unknown) {}

  @Post()
  objectKeyword(@Body() dto: object) {}

  @Post()
  typeLiteral(@Body() body: { reason?: string; amount: number }) {}

  @Post()
  importType(@Body() dto: import('./dto/register.dto').RegisterDto) {}

  @Post()
  union(@Body() dto: CreateThingDto | UpdateThingDto) {}

  @Post()
  intersection(@Body() dto: CreateThingDto & AuditFields) {}

  @Post()
  arrayType(@Body() items: CreateThingDto[]) {}

  @Post()
  tupleType(@Body() pair: [string, number]) {}

  @Patch()
  partialUtility(@Body() dto: Partial<CreateThingDto>) {}

  @Post()
  recordUtility(@Body() payload: Record<string, unknown>) {}

  @Post()
  omitUtility(@Body() dto: Omit<CreateThingDto, 'id'>) {}

  @Post()
  skippedBuiltin(@Body() when: Date) {}

  @Post()
  noAnnotation(@Body() dto) {}
}
`;

/** The verdicts both front ends are expected to produce, in source order. */
const EXPECTED = [
  'erasedKeyword',
  'erasedKeyword',
  'erasedKeyword',
  'erasedTypeLiteral',
  'erasedImportType',
  'erasedComposite',
  'erasedComposite',
  'erasedArrayLike',
  'erasedArrayLike',
  'erasedPartial',
  'erasedUtility',
  'erasedUtility',
  'skippedBuiltin',
  'missingAnnotation',
];

function lintVerdicts(code, filename = 'thing.controller.ts') {
  const linter = new Linter();
  const messages = linter.verify(
    code,
    {
      // Without `files`, a .ts filename matches no config and ESLint reports
      // "No matching configuration found" instead of running the rule.
      files: ['**/*.ts'],
      plugins: { 'silent-dto': plugin },
      languageOptions: { parser: tsParser, ecmaVersion: 2022, sourceType: 'module' },
      rules: { 'silent-dto/no-unvalidated-body': 'error' },
    },
    filename,
  );
  // Anything not attributed to our rule is a parse error or a config problem,
  // and would otherwise show up as a silent `undefined` in the verdict list.
  const foreign = messages.filter((m) => m.ruleId !== 'silent-dto/no-unvalidated-body');
  assert.deepEqual(foreign, [], `unexpected lint output: ${JSON.stringify(foreign)}`);
  return messages.map((m) => m.messageId);
}

function scanVerdicts(code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'silent-dto-parity-'));
  try {
    const file = path.join(dir, 'thing.controller.ts');
    fs.writeFileSync(file, code);
    return scanFile(file, dir).map((f) => f.rule);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the CLI scanner produces the expected verdicts', () => {
  assert.deepEqual(scanVerdicts(FIXTURE), EXPECTED);
});

test('the ESLint rule produces the expected verdicts', () => {
  assert.deepEqual(lintVerdicts(FIXTURE), EXPECTED);
});

test('the two front ends agree, shape for shape', () => {
  assert.deepEqual(scanVerdicts(FIXTURE), lintVerdicts(FIXTURE));
});

test('both front ends stay silent on a clean controller', () => {
  const clean = `import { Body, Post } from '@nestjs/common';
import { CreateThingDto } from './dto/create-thing.dto';

class ThingController {
  @Post()
  create(@Body() dto: CreateThingDto) {}
}
`;
  assert.deepEqual(scanVerdicts(clean), []);
  assert.deepEqual(lintVerdicts(clean), []);
});
