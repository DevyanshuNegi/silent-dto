# silent-dto

[![npm version](https://img.shields.io/npm/v/silent-dto)](https://www.npmjs.com/package/silent-dto)
[![CI](https://github.com/DevyanshuNegi/silent-dto/actions/workflows/ci.yml/badge.svg)](https://github.com/DevyanshuNegi/silent-dto/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/silent-dto)](LICENSE)

**Find the `@Body()` parameters where NestJS silently skipped validation.**

Your global `ValidationPipe` doesn't run on every route. On some of them it hands the raw request body straight to your handler — no whitelisting, no coercion, and every `@IsEnum` / `@IsUUID` / `@Min` on the DTO dead. The route looks validated in review. It isn't.

In one production codebase it found **36 of 222 whole-body handlers** in this state. Today four remain — all deliberate webhook receivers — and the rest are gated so no new ones appear.

![npx eslint . reports: Replace `Partial<UpdateVehicleDto>` with a real class: `class PartialUpdateVehicleDto extends PartialType(UpdateVehicleDto) {}` — the error message is the fix. silent-dto/no-unvalidated-body](docs/demo.gif)

---

## Install

```bash
npm i -D silent-dto
```

```js
// eslint.config.mjs
import silentDto from 'silent-dto';

export default [
  // ... your existing config, including a TypeScript parser
  silentDto.configs.recommended,
];
```

That's it. The rule now runs on every save, every commit and every CI run.

`configs.recommended` is scoped to `**/*.controller.ts` and needs no type information — no `parserServices`, no `ts.Program`, so it costs plain-lint speed. Use `configs.all` if your handlers don't follow the `.controller.ts` convention.

> **Flat config only.** ESLint 10 removed `.eslintrc`, and with it the `plugins: ["..."]` string shorthand that was the only reason plugins needed an `eslint-plugin-` name prefix. Under flat config the plugin is imported as a value, so the package is named after the tool. Requires ESLint 9+ and a TypeScript parser (which every NestJS repo already configures).

**[→ Full rule documentation](docs/rules/no-unvalidated-body.md)**

### One-shot audit

To see what you're in for before wiring anything up:

```bash
npx silent-dto
```

```
silent-dto: 3 @Body() parameter(s) where ValidationPipe does nothing.

  src/modules/auth/auth.controller.ts:6
    AuthController.register()  @Body() import('./dto/register.dto').RegisterDto
    ↳ `import('...')` type has no value binding, so it erases to Object

  src/modules/billing/billing.controller.ts:6
    BillingController.adjust()  @Body() { reason?: string; amount: number }
    ↳ inline object literal type erases to Object

  src/modules/fleet/fleet.controller.ts:7
    FleetController.update()  @Body() Partial<UpdateVehicleDto>
    ↳ `Partial<…>` is a type-only utility, not a value — erases to Object
```

The CLI and the lint rule classify through the same code and are held to identical verdicts by a [parity test](tests/parity.test.mjs). Treat the CLI as the audit and the rule as the thing you keep — a run-once tool doesn't stop the problem coming back.

---

## Why this happens

`ValidationPipe` only runs when the parameter's **emitted metatype is a class**. Internally, [`toValidate()`](https://github.com/nestjs/nest/blob/master/packages/common/pipes/validation.pipe.ts) returns `false` for `String | Boolean | Number | Array | Object | Buffer | Date` — and when it returns false the pipe returns your body **untouched**.

TypeScript's `emitDecoratorMetadata` writes `Object` into `design:paramtypes` whenever the annotation is not a plain reference to a **value**. A type is not a value. So all of these compile to `Object`:

| Annotation | Emitted metatype | Validated? |
|---|---|---|
| `@Body() dto: CreateThingDto` | `CreateThingDto` | ✅ yes |
| `@Body() dto: any` | `Object` | ❌ no |
| `@Body() dto: unknown` | `Object` | ❌ no |
| `@Body() body: { reason?: string }` | `Object` | ❌ no |
| `@Body() dto: Partial<CreateThingDto>` | `Object` | ❌ no |
| `@Body() dto: Record<string, unknown>` | `Object` | ❌ no |
| `@Body() dto: CreateDto \| UpdateDto` | `Object` | ❌ no |
| `@Body() items: ItemDto[]` | `Array` | ❌ no |
| `@Body() dto: import('./dto/x').ThingDto` | `Object` | ❌ no |

Every row of that table is [checked against the actual compiler](tests/verify-dist.test.mjs) rather than asserted.

### The one that catches everybody

```ts
@Body() dto: Partial<CreateThingDto>       // ❌ TS utility type — erases to Object

class UpdateThingDto extends PartialType(CreateThingDto) {}
@Body() dto: UpdateThingDto                // ✅ Nest mapped-type helper — a real class
```

`Partial<T>` and Nest's `PartialType()` read almost identically and behave completely differently. One is a compile-time type; the other returns an actual class with the metadata copied across. If you want an optional-fields DTO, you must use the second.

### The one that's hardest to spot in review

```ts
@Body() dto: import('./dto/register.dto').RegisterDto
```

The DTO's decorators are *right there* in the file being pointed at. Open it and you'll see `@IsEmail()`, `@MinLength(8)`. Every one of them is dead — there's no value binding in scope, so the metatype is `Object`.

Import the same DTO normally and it validates fine. The difference is invisible at the call site.

---

## What you actually lose

When the pipe skips a route, three things go at once:

1. **Whitelisting.** `whitelist: true` and `forbidNonWhitelisted: true` stop applying. Unknown keys reach your handler — and reach your ORM if that body is ever spread into a `data:`. This is the one that turns a validation gap into a mass-assignment bug.
2. **Transformation.** No coercion. `"5"` stays a string, `"true"` stays a string.
3. **Every constraint on the DTO.** `@IsEnum`, `@IsUUID`, `@Min`, `@MaxLength` — all inert.

The first only bites if you set `whitelist: true`. Without it the failure is "your constraints don't run" — bad, but not automatically a security hole.

---

## Fixes are suggestions, not autofixes

Two cases carry a one-keystroke code action:

- **`Partial<T>`** → generates `class PartialT extends PartialType(T) {}`, adds the `@nestjs/mapped-types` import if missing, and repoints the parameter.
- **`import('./x').Dto`** → hoists it to a real `import` and repoints the parameter.

Both are ESLint **suggestions**, so `eslint --fix` will not apply them. One invents a class and the other adds a module binding; neither belongs in an unattended `--fix` sweep. A suggestion is withheld entirely when it isn't provably safe — a non-trivial type argument, or a generated name that already occurs in the file.

The error messages state the remedy rather than just the diagnosis, which is deliberate: a coding agent that re-runs lint after editing will read the message and apply the fix without being told the tool exists.

---

## Adopting on an existing codebase

You will almost certainly have findings on day one. Don't let that stop you shipping the gate:

```bash
npx silent-dto --baseline   # writes .silent-dto-baseline.json
git add .silent-dto-baseline.json
```

Existing findings are now recorded and pass. **New ones fail.** Work the baseline down as you touch each file — the point is to stop the bleeding first.

For the lint rule, the equivalent is a disable comment carrying the reason:

```ts
// eslint-disable-next-line silent-dto/no-unvalidated-body -- Daraja owns this shape; validated in-handler
@Post('callback')
handleCallback(@Body() payload: Record<string, unknown>) {}
```

---

## Is the rule trustworthy?

The authoritative signal is the compiled `__metadata("design:paramtypes", [...])` in your build output. This tool deliberately **doesn't** build your project (a pre-push gate can't afford it) and doesn't construct a full `ts.Program` (a whole-repo typecheck is slower than the suite it's guarding). It applies a conservative syntactic rule to the source AST.

So don't take the rule on faith — **check it against your own compiler**:

```bash
npm run build
npx silent-dto --verify-dist          # defaults to ./dist
npx silent-dto --verify-dist=build    # or point it somewhere else
```

```
silent-dto: the syntactic rule matches the compiler on all 222 whole-body handler(s). ✅
```

It reads the real `design:paramtypes` your compiler emitted, positionally, per handler, and exits 1 listing any handler where the rule and the compiler disagree. In the codebase this came from it reproduced the `dist`-derived verdict for all **222** whole-body handlers exactly: **186 validated, 36 not.**

The same check runs in this repo's own test suite against a fixture compiled by `tsc` on every run, so if TypeScript ever changes how it serialises one of these annotations, a test fails instead of the tool quietly becoming wrong.

**The rule is conservative in the safe direction.** Anything that isn't an obvious bare class reference gets reported. A false positive costs you one disable comment. A false negative is an unvalidated production endpoint.

### What findings look like once you've worked the list

The four that survive in the codebase this came from are all the same shape:

```
modules/payments/mpesa.controller.ts:32   MpesaController.handleCallback()   Record<string, unknown>
modules/payments/mpesa.controller.ts:51   MpesaController.handleResult()     Record<string, unknown>
modules/payments/mpesa.controller.ts:70   MpesaController.handleTimeout()    Record<string, unknown>
modules/telematics/telematics.controller.ts:61  TelematicsController.ingest() unknown
```

Payment-provider callbacks and a telematics ingest endpoint — places you receive a payload whose shape a third party controls and can change without telling you. `Record<string, unknown>` is a defensible choice there.

But be honest about what you're accepting: **no whitelisting on an endpoint that a stranger can POST to.** If you take that trade, validate inside the handler and never spread that body into an ORM `data:`. The tool's job isn't to tell you the answer — it's to make sure the decision was made on purpose rather than by a type annotation nobody looked at twice.

### Known limits

- **A class reached through a type alias is a false positive.** `type Dto = CreateThingDto` validates fine at runtime but is reported. That's the conservative direction, and it's the price of staying syntactic.
- Only bare `@Body()`. `@Body('field')` is skipped deliberately — pulling one property isn't expected to validate.
- The CLI walks `.controller.ts` only; `configs.all` lifts that restriction for the lint rule.
- Requires `emitDecoratorMetadata: true`. If yours is off, **every** route is unvalidated and you have a bigger problem than this tool.
- **`nestjs-zod` / zod-pipe users are unaffected** — they bypass class-validator entirely, so the metatype never mattered.

---

## Why this exists

I'm the sole engineer on a logistics and payments platform where AI wrote most of the code. I went looking because I'd stopped being able to answer "is validation on?" by reading the code.

`@Body() dto: Partial<UpdateThingDto>` is exactly the kind of thing an assistant writes — it's idiomatic TypeScript, it type-checks, it reads correctly in review, and it silently disables the pipe. It was written that way because it *looks* right. Nothing fails, nothing logs, the route works.

So the fix isn't reviewing harder. It's making the invariant mechanical — and then putting the mechanism somewhere it runs on its own. That's why this is a lint rule and not just a scanner: the check now sits inside the same loop that produced the bug, and the error message says what to write.

Run it on your own codebase. If it prints nothing, you've lost a second. If it prints something, you probably want to know.

---

MIT
