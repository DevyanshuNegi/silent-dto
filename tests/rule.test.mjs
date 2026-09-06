/**
 * Behaviour of `silent-dto/no-unvalidated-body`.
 *
 * The invalid cases double as the documentation of what the rule considers
 * erased, so each one is a shape that really appears in NestJS controllers
 * rather than a minimal repro.
 */

import { describe, it } from 'node:test';
import { RuleTester } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import plugin from '../dist/index.js';

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

const HEAD = `import { Body, Patch, Post } from '@nestjs/common';\n`;

/** Wrap a parameter list in a controller so cases stay one line each. */
const ctrl = (params) =>
  `${HEAD}\nclass ThingController {\n  @Post()\n  create(${params}) {}\n}\n`;

ruleTester.run('no-unvalidated-body', plugin.rules['no-unvalidated-body'], {
  valid: [
    // The shape that actually validates: a bare class reference.
    ctrl('@Body() dto: CreateThingDto'),
    // Namespaced class references are still values.
    ctrl('@Body() dto: dtos.CreateThingDto'),
    // `@Body('field')` pulls one property — the pipe is not expected to validate it.
    ctrl("@Body('reason') reason: string"),
    ctrl("@Body('count') count: number"),
    // Other parameter decorators are none of this rule's business.
    ctrl("@Param('id') id: string"),
    ctrl('@Query() q: any'),
    // An undecorated parameter, however erased, is not a request body.
    ctrl('dto: Partial<CreateThingDto>'),
    // Constructor injection must not be mistaken for a handler parameter.
    `${HEAD}\nclass ThingController {\n  constructor(private readonly svc: any) {}\n}\n`,
    // A class-shaped mapped type is a value and validates correctly.
    ctrl('@Body() dto: UpdateThingDto'),
  ],

  invalid: [
    {
      name: 'any',
      code: ctrl('@Body() dto: any'),
      errors: [{ messageId: 'erasedKeyword', data: { annotation: 'any' } }],
    },
    {
      name: 'unknown',
      code: ctrl('@Body() dto: unknown'),
      errors: [{ messageId: 'erasedKeyword', data: { annotation: 'unknown' } }],
    },
    {
      name: 'object',
      code: ctrl('@Body() dto: object'),
      errors: [{ messageId: 'erasedKeyword', data: { annotation: 'object' } }],
    },
    {
      name: 'inline object literal type',
      code: ctrl('@Body() body: { reason?: string; amount: number }'),
      errors: [{ messageId: 'erasedTypeLiteral' }],
    },
    {
      name: 'union',
      code: ctrl('@Body() dto: CreateDto | UpdateDto'),
      errors: [{ messageId: 'erasedComposite', data: { kind: 'union' } }],
    },
    {
      name: 'intersection',
      code: ctrl('@Body() dto: CreateDto & AuditFields'),
      errors: [{ messageId: 'erasedComposite', data: { kind: 'intersection' } }],
    },
    {
      name: 'array erases to Array, which the pipe also skips',
      code: ctrl('@Body() items: ItemDto[]'),
      errors: [{ messageId: 'erasedArrayLike' }],
    },
    {
      name: 'tuple',
      code: ctrl('@Body() pair: [string, number]'),
      errors: [{ messageId: 'erasedArrayLike' }],
    },
    {
      name: 'Record',
      code: ctrl('@Body() payload: Record<string, unknown>'),
      errors: [
        {
          messageId: 'erasedUtility',
          data: { name: 'Record', annotation: 'Record<string, unknown>' },
        },
      ],
    },
    {
      name: 'Omit',
      code: ctrl('@Body() dto: Omit<CreateThingDto, "id">'),
      errors: [
        {
          messageId: 'erasedUtility',
          data: { name: 'Omit', annotation: 'Omit<CreateThingDto, "id">' },
        },
      ],
    },
    {
      name: 'a builtin the pipe refuses outright',
      code: ctrl('@Body() when: Date'),
      errors: [{ messageId: 'skippedBuiltin', data: { name: 'Date' } }],
    },
    {
      name: 'no annotation at all',
      code: ctrl('@Body() dto'),
      errors: [{ messageId: 'missingAnnotation' }],
    },
    {
      name: 'every handler in a controller is checked',
      code: `${HEAD}\nclass ThingController {\n  @Post()\n  create(@Body() a: any) {}\n  @Patch()\n  update(@Body() b: Record<string, unknown>) {}\n}\n`,
      errors: [{ messageId: 'erasedKeyword' }, { messageId: 'erasedUtility' }],
    },

    /* --- the two cases that carry a suggestion --- */

    {
      name: 'Partial<T> suggests the Nest mapped-type equivalent',
      code:
        `import { Body, Patch } from '@nestjs/common';\n` +
        `import { UpdateVehicleDto } from './dto/update-vehicle.dto';\n` +
        `\nclass FleetController {\n  @Patch()\n  update(@Body() dto: Partial<UpdateVehicleDto>) {}\n}\n`,
      errors: [
        {
          messageId: 'erasedPartial',
          data: {
            annotation: 'Partial<UpdateVehicleDto>',
            inner: 'UpdateVehicleDto',
            suggested: 'PartialUpdateVehicleDto',
          },
          suggestions: [
            {
              messageId: 'useMappedType',
              output:
                `import { Body, Patch } from '@nestjs/common';\n` +
                `import { UpdateVehicleDto } from './dto/update-vehicle.dto';\n` +
                `import { PartialType } from '@nestjs/mapped-types';\n` +
                `\nclass PartialUpdateVehicleDto extends PartialType(UpdateVehicleDto) {}\n` +
                `\nclass FleetController {\n  @Patch()\n  update(@Body() dto: PartialUpdateVehicleDto) {}\n}\n`,
            },
          ],
        },
      ],
    },
    {
      name: 'an existing PartialType import is not duplicated',
      code:
        `import { Body, Patch } from '@nestjs/common';\n` +
        `import { PartialType } from '@nestjs/mapped-types';\n` +
        `import { UpdateVehicleDto } from './dto/update-vehicle.dto';\n` +
        `\nclass FleetController {\n  @Patch()\n  update(@Body() dto: Partial<UpdateVehicleDto>) {}\n}\n`,
      errors: [
        {
          messageId: 'erasedPartial',
          suggestions: [
            {
              messageId: 'useMappedType',
              output:
                `import { Body, Patch } from '@nestjs/common';\n` +
                `import { PartialType } from '@nestjs/mapped-types';\n` +
                `import { UpdateVehicleDto } from './dto/update-vehicle.dto';\n` +
                `\nclass PartialUpdateVehicleDto extends PartialType(UpdateVehicleDto) {}\n` +
                `\nclass FleetController {\n  @Patch()\n  update(@Body() dto: PartialUpdateVehicleDto) {}\n}\n`,
            },
          ],
        },
      ],
    },
    {
      name: 'Partial<T> where the generated name is already taken offers no suggestion',
      code:
        `import { Body, Patch } from '@nestjs/common';\n` +
        `import { UpdateVehicleDto } from './dto/update-vehicle.dto';\n` +
        `\nclass PartialUpdateVehicleDto {}\n` +
        `\nclass FleetController {\n  @Patch()\n  update(@Body() dto: Partial<UpdateVehicleDto>) {}\n}\n`,
      errors: [{ messageId: 'erasedPartial', suggestions: [] }],
    },
    {
      name: 'import() type is hoisted to a real import',
      code:
        `import { Body, Post } from '@nestjs/common';\n` +
        `\nclass AuthController {\n  @Post()\n  register(@Body() dto: import('./dto/register.dto').RegisterDto) {}\n}\n`,
      errors: [
        {
          messageId: 'erasedImportType',
          data: { name: 'RegisterDto', source: './dto/register.dto' },
          suggestions: [
            {
              messageId: 'hoistImportType',
              output:
                `import { Body, Post } from '@nestjs/common';\n` +
                `import { RegisterDto } from './dto/register.dto';\n` +
                `\nclass AuthController {\n  @Post()\n  register(@Body() dto: RegisterDto) {}\n}\n`,
            },
          ],
        },
      ],
    },
    {
      name: 'import() type extends an existing import from the same module',
      code:
        `import { Body, Post } from '@nestjs/common';\n` +
        `import { LoginDto } from './dto/register.dto';\n` +
        `\nclass AuthController {\n  @Post()\n  register(@Body() dto: import('./dto/register.dto').RegisterDto) {}\n}\n`,
      errors: [
        {
          messageId: 'erasedImportType',
          suggestions: [
            {
              messageId: 'hoistImportType',
              output:
                `import { Body, Post } from '@nestjs/common';\n` +
                `import { LoginDto, RegisterDto } from './dto/register.dto';\n` +
                `\nclass AuthController {\n  @Post()\n  register(@Body() dto: RegisterDto) {}\n}\n`,
            },
          ],
        },
      ],
    },
    {
      name: 'import() type already imported only needs the annotation rewritten',
      code:
        `import { Body, Post } from '@nestjs/common';\n` +
        `import { RegisterDto } from './dto/register.dto';\n` +
        `\nclass AuthController {\n  @Post()\n  register(@Body() dto: import('./dto/register.dto').RegisterDto) {}\n}\n`,
      errors: [
        {
          messageId: 'erasedImportType',
          suggestions: [
            {
              messageId: 'hoistImportType',
              output:
                `import { Body, Post } from '@nestjs/common';\n` +
                `import { RegisterDto } from './dto/register.dto';\n` +
                `\nclass AuthController {\n  @Post()\n  register(@Body() dto: RegisterDto) {}\n}\n`,
            },
          ],
        },
      ],
    },
  ],
});
