/**
 * The shared vocabulary between the ESLint rule and the CLI scanner.
 *
 * Both front ends walk a different AST (TSESTree vs the TypeScript compiler's own)
 * but must reach the *same verdict* on the same source, because the README's
 * trustworthiness claim rests on the classification being one rule rather than two
 * implementations that happen to agree today. Everything decidable without an AST
 * lives here; `rule.ts` and `scan.ts` only map their node kinds onto these ids.
 *
 * Each id renders two ways:
 *
 *   short()   one clause, for a terminal list where the file:line is the point
 *   MESSAGES  the full remedy, for ESLint — where the message is read by a human
 *             in an editor tooltip, or by a coding agent that will act on it
 *
 * The second is why the messages are phrased as instructions rather than
 * diagnoses. An agent that runs lint after editing and fixes what comes back
 * needs to be told what to write, not merely what is wrong.
 */

/** Why an annotation cannot carry validation metadata. */
export type ErasureId =
  | 'missingAnnotation'
  | 'erasedKeyword'
  | 'erasedTypeLiteral'
  | 'erasedImportType'
  | 'erasedComposite'
  | 'erasedArrayLike'
  | 'erasedPartial'
  | 'erasedUtility'
  | 'skippedBuiltin'
  | 'unrecognised';

export type ErasureData = {
  /** Source text of the annotation, e.g. `Partial<CreateThingDto>`. */
  annotation?: string;
  /** A bare identifier — the utility name, builtin name, or imported type name. */
  name?: string;
  /** Module specifier for `erasedImportType`. */
  source?: string;
  /** 'union' | 'intersection' for `erasedComposite`; the raw node kind for `unrecognised`. */
  kind?: string;
  /** For `erasedPartial`: the type argument, e.g. `CreateThingDto`. */
  inner?: string;
  /** For `erasedPartial`: the class name we propose generating. */
  suggested?: string;
};

export type Erasure = { id: ErasureId; data: ErasureData };

/**
 * TS utility types that erase to `Object`.
 *
 * NOTE: `Partial<T>` here is the TypeScript utility type. It is NOT Nest's
 * `PartialType()` mapped-type helper, which returns a real class and validates
 * correctly. That distinction is the single most common source of confusion on
 * this bug, which is why `Partial` gets its own id and its own suggestion.
 */
export const TYPE_ONLY_UTILITIES = new Set([
  'Partial',
  'Required',
  'Readonly',
  'Record',
  'Pick',
  'Omit',
  'Exclude',
  'Extract',
  'NonNullable',
  'ReturnType',
  'InstanceType',
  'Parameters',
]);

/** Built-ins `ValidationPipe.toValidate()` explicitly refuses. */
export const PIPE_SKIPPED_BUILTINS = new Set([
  'String',
  'Boolean',
  'Number',
  'Array',
  'Object',
  'Buffer',
  'Date',
]);

/** One clause, for the CLI's `↳` line. */
export function short({ id, data }: Erasure): string {
  switch (id) {
    case 'missingAnnotation':
      return 'no type annotation';
    case 'erasedKeyword':
      return `\`${data.annotation}\` erases to Object`;
    case 'erasedTypeLiteral':
      return 'inline object literal type erases to Object';
    case 'erasedImportType':
      return "`import('...')` type has no value binding, so it erases to Object";
    case 'erasedComposite':
      return `${data.kind} type erases to Object`;
    case 'erasedArrayLike':
      return 'array/tuple erases to Array, which the pipe skips';
    case 'erasedPartial':
    case 'erasedUtility':
      return `\`${data.name}<…>\` is a type-only utility, not a value — erases to Object`;
    case 'skippedBuiltin':
      return `\`${data.name}\` is skipped by ValidationPipe.toValidate()`;
    case 'unrecognised':
      return `unrecognised annotation kind (${data.kind}) — treated as unsafe`;
  }
}

/**
 * ESLint `meta.messages`. Remedy first, mechanism second — see the file header.
 *
 * Kept to a single line each: `stylish` and most editor tooltips collapse or
 * ragged-wrap embedded newlines, and a one-line message stays greppable in the
 * CI log an agent is reading.
 */
export const MESSAGES = {
  missingAnnotation:
    'Annotate this `@Body()` parameter with a DTO class — `@Body() dto: CreateThingDto` — and put class-validator decorators on that class. An unannotated parameter emits `Object` into `design:paramtypes`, and ValidationPipe skips every parameter whose metatype is `Object`, so nothing on this body is validated.',

  erasedKeyword:
    'Replace `{{annotation}}` on this `@Body()` parameter with a DTO class carrying class-validator decorators. `{{annotation}}` emits `Object` into `design:paramtypes`, and ValidationPipe skips `Object`, so whitelisting, transformation and every constraint on the body are inactive on this route.',

  erasedTypeLiteral:
    'Move this inline object type into a DTO class with class-validator decorators, and annotate the parameter with that class. An inline object literal type emits `Object` into `design:paramtypes`, and ValidationPipe skips `Object`, so the body reaches your handler untouched.',

  erasedImportType:
    "Import `{{name}}` with a real import statement — `import { {{name}} } from '{{source}}'` — and annotate the parameter with it. An `import('...')` type has no value binding in scope, so TypeScript emits `Object` into `design:paramtypes` and ValidationPipe skips this parameter: every decorator on `{{name}}` is dead despite being visible in that file.",

  erasedComposite:
    'Annotate this `@Body()` parameter with a single DTO class. A {{kind}} type emits `Object` into `design:paramtypes`, so ValidationPipe skips this parameter. If the shapes genuinely differ, split the route or use one DTO with optional fields and a discriminator field.',

  erasedArrayLike:
    'Wrap this in a DTO class holding one `@ValidateNested({ each: true })` + `@Type(() => ItemDto)` property, or apply `ParseArrayPipe({ items: ItemDto })` to the parameter. `{{annotation}}` emits `Array` into `design:paramtypes`, and ValidationPipe skips `Array` outright, so no element is validated.',

  erasedPartial:
    'Replace `{{annotation}}` with a real class: `class {{suggested}} extends PartialType({{inner}}) {}` (`PartialType` from `@nestjs/mapped-types`), then annotate this parameter with `{{suggested}}`. TypeScript\'s `Partial<T>` is a type-only utility with no runtime value, so it emits `Object` into `design:paramtypes` and ValidationPipe skips the parameter — Nest\'s `PartialType()` returns an actual class and copies the validation metadata across.',

  erasedUtility:
    'Replace `{{annotation}}` with a DTO class. Nest ships runtime equivalents of these utilities — `PartialType`, `PickType`, `OmitType`, `IntersectionType` from `@nestjs/mapped-types` — which return real classes. `{{name}}<…>` is a type-only utility with no runtime value, so it emits `Object` into `design:paramtypes` and ValidationPipe skips this parameter.',

  skippedBuiltin:
    'Annotate this `@Body()` parameter with a DTO class instead of `{{name}}`. `ValidationPipe.toValidate()` explicitly refuses `String | Boolean | Number | Array | Object | Buffer | Date`, so the pipe returns the raw body to your handler without validating or transforming it.',

  unrecognised:
    'Annotate this `@Body()` parameter with a bare DTO class reference. `{{annotation}}` is not a plain class reference, so it is unlikely to emit a class into `design:paramtypes`, and anything other than a class makes ValidationPipe skip the parameter. If this annotation really does resolve to a class, this is a false positive — please open an issue.',

  // Suggestion labels (code-action titles, so: short, imperative).
  useMappedType: 'Create `class {{suggested}} extends PartialType({{inner}}) {}` and use it here',
  hoistImportType: 'Import `{{name}}` from `{{source}}` and use it here',
} as const;

export type MessageId = keyof typeof MESSAGES;
