# `silent-dto/no-unvalidated-body`

> Require every whole-body `@Body()` parameter to be annotated with a class, so `ValidationPipe` actually runs on it.

A global `ValidationPipe` does not run on every route. On some of them it hands the raw request body straight to your handler — no whitelisting, no coercion, and every `@IsEnum` / `@IsUUID` / `@Min` on the DTO inert. The route looks validated in review. It isn't.

This rule finds those routes.

## Why the pipe skips a route

`ValidationPipe` checks the parameter's **metatype** before doing anything, and bails if that metatype is a built-in:

```ts
// packages/common/pipes/validation.pipe.ts
protected toValidate(metatype: Type<unknown>): boolean {
  const types: Type<unknown>[] = [String, Boolean, Number, Array, Object, Buffer, Date];
  return !types.some(t => metatype === t) && !isNil(metatype);
}
```

When `toValidate()` returns false the pipe returns your value **unchanged**. No error, no warning, no log line.

What the metatype *is* gets decided by TypeScript, not by Nest. With `emitDecoratorMetadata: true` the compiler writes `design:paramtypes` for decorated methods — and it can only write a **value** there. Classes are values. Types are not. So every annotation that isn't a plain reference to a class compiles to `Object`, and `Object` is on the skip list.

## What it reports

| Annotation | Emitted metatype | Reported |
|---|---|---|
| `@Body() dto: CreateThingDto` | `CreateThingDto` | — |
| `@Body() dto: any` | `Object` | ✅ |
| `@Body() dto: unknown` | `Object` | ✅ |
| `@Body() dto: object` | `Object` | ✅ |
| `@Body() body: { reason?: string }` | `Object` | ✅ |
| `@Body() dto: Partial<CreateThingDto>` | `Object` | ✅ |
| `@Body() dto: Record<string, unknown>` | `Object` | ✅ |
| `@Body() dto: CreateDto \| UpdateDto` | `Object` | ✅ |
| `@Body() dto: CreateDto & Audit` | `Object` | ✅ |
| `@Body() items: ItemDto[]` | `Array` | ✅ |
| `@Body() dto: import('./dto/x').ThingDto` | `Object` | ✅ |
| `@Body() dto` | `Object` | ✅ |

`@Body('field')` is deliberately **not** reported — pulling a single property out of the body isn't expected to validate.

### The one that catches everybody

```ts
@Body() dto: Partial<CreateThingDto>   // ❌ TypeScript utility type — erases to Object

class UpdateThingDto extends PartialType(CreateThingDto) {}
@Body() dto: UpdateThingDto            // ✅ a real class
```

`Partial<T>` and Nest's `PartialType()` read almost identically and behave completely differently. One is a compile-time type that evaporates; the other returns an actual class with the validation metadata copied across. If you want an optional-fields DTO you need the second.

The rule offers this rewrite as a **suggestion** on `Partial<T>`.

### The one that's hardest to spot in review

```ts
@Body() dto: import('./dto/register.dto').RegisterDto
```

Open `register.dto.ts` and you'll find `@IsEmail()`, `@MinLength(8)`, all of it. Every one is dead — there's no value binding in scope, so the metatype is `Object`. The evidence that it's validated is sitting one file away, which is exactly what makes it convincing.

The rule offers a suggestion that hoists this into a real `import` and points the parameter at it. That rewrite is exactly equivalent, so it's mechanical.

## What you actually lose

Three things go at once, and only one of them is "validation":

1. **Whitelisting.** `whitelist` and `forbidNonWhitelisted` stop applying. Unknown keys reach your handler — and reach your ORM if that body is ever spread into a `data:`. That's a mass-assignment bug wearing a validation bug's clothes.
2. **Transformation.** No coercion. `"5"` stays a string, `"true"` stays a string.
3. **Every constraint on the DTO.**

Note the first only bites if you set `whitelist: true`. Without it, the failure is "your constraints don't run" — bad, but not automatically a security hole.

## Options

None. The check is binary and there is no defensible middle setting.

## Suggestions, not fixes

Both rewrites are ESLint **suggestions** rather than autofixes, so `eslint --fix` will not apply them. One invents a class and the other adds a module binding; neither belongs in an unattended `--fix` sweep. In an editor they're a one-keystroke code action.

A suggestion is withheld when it isn't provably safe — a `Partial<T>` over a non-trivial type argument, or a generated name that already occurs in the file.

## When not to use it

Two audiences get nothing from this rule:

- **`nestjs-zod` / zod-pipe users.** They bypass class-validator entirely, so the metatype never mattered.
- **Repos with `emitDecoratorMetadata: false`.** There, *every* route is unvalidated and you have a bigger problem than this rule.

## Suppressing a deliberate one

Webhook receivers are the honest exception — a payload whose shape a third party owns and can change without telling you:

```ts
// eslint-disable-next-line silent-dto/no-unvalidated-body -- Daraja owns this shape; validated in-handler
@Post('callback')
handleCallback(@Body() payload: Record<string, unknown>) {}
```

Be honest about what the disable comment buys: **no whitelisting on an endpoint a stranger can POST to.** If you take that trade, validate inside the handler and never hand that object to an ORM. The rule's job isn't to tell you the answer — it's to make sure the decision was made on purpose rather than by a type annotation nobody looked at twice.

## Known limits

- **A class reached through a type alias is a false positive.** `type Dto = CreateThingDto` validates fine at runtime, but the rule is syntactic and reports it. That's the deliberate direction to be wrong in: a false positive costs one disable comment, a false negative is an unvalidated production endpoint.
- Only bare `@Body()`. `@Body('field')` is skipped by design.
- Only method parameters. A handler written as a class property holding an arrow function is not checked — but `emitDecoratorMetadata` doesn't emit `design:paramtypes` for those either, so Nest can't route to them normally.

## Why syntactic and not type-aware

The classification never resolves a symbol, so the rule needs no `parserServices` and no `ts.Program`. It runs at plain-lint speed in any repo that already runs typescript-eslint, which is all of them. The type-alias false positive above is the price, and it's a cheap one.

The authoritative signal is the compiled `__metadata("design:paramtypes", [...])` in your build output. Don't take the rule on faith — the CLI's `--verify-dist` mode differential-tests the heuristic against your own compiled output.
