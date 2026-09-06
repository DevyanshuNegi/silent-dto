/**
 * The differential check, run for real.
 *
 * This is the test the whole artifact rests on: the rule is a *syntactic guess*
 * about what `emitDecoratorMetadata` will write into `design:paramtypes`, so the
 * guess is compiled by the actual TypeScript compiler and the two verdicts are
 * compared handler by handler. If TypeScript ever changes how it serialises one
 * of these annotations, this fails instead of the tool quietly becoming wrong.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

import { verifyAgainstDist, compiledParamtypes } from '../dist/scan.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'dist', 'scan.js');

/**
 * Self-contained so the compiler emits real metadata: the decorators are local
 * stand-ins with the same names Nest uses, and every DTO is a real class. A
 * fixture that referenced undeclared types would emit `Object` for them and
 * manufacture a disagreement that says nothing about the rule.
 */
const DTO_FILE = `export class RegisterDto {
  email!: string;
}
`;

const CONTROLLER = `import { RegisterDto } from './register.dto';

function Body(prop?: string): ParameterDecorator {
  return () => undefined;
}
function Post(): MethodDecorator {
  return () => undefined;
}

export class CreateThingDto {
  name!: string;
}
export class UpdateThingDto {
  name?: string;
}
export class AuditFields {
  at!: Date;
}

export class ThingController {
  @Post()
  validated(@Body() dto: CreateThingDto) {}

  @Post()
  anyKeyword(@Body() dto: any) {}

  @Post()
  unknownKeyword(@Body() dto: unknown) {}

  @Post()
  partialUtility(@Body() dto: Partial<CreateThingDto>) {}

  @Post()
  recordUtility(@Body() payload: Record<string, unknown>) {}

  @Post()
  typeLiteral(@Body() body: { reason?: string }) {}

  @Post()
  unionType(@Body() dto: CreateThingDto | UpdateThingDto) {}

  @Post()
  intersectionType(@Body() dto: CreateThingDto & AuditFields) {}

  @Post()
  arrayType(@Body() items: CreateThingDto[]) {}

  @Post()
  builtinDate(@Body() when: Date) {}

  @Post()
  importedDto(@Body() dto: RegisterDto) {}

  // The flagship case: the DTO's decorators are visible one file away, but there
  // is no value binding in scope, so the metatype is Object.
  @Post()
  inlineImportType(@Body() dto: import('./register.dto').RegisterDto) {}

  // The @Body() sits at index 1, so this fails if the paramtypes entry is read
  // positionally-wrong.
  @Post()
  bodyNotFirst(@Body('reason') reason: string, @Body() dto: CreateThingDto) {}
}

// Same method name as above, different class: catches a block matcher that
// ignores the owning class.
export class OtherController {
  @Post()
  anyKeyword(@Body() dto: CreateThingDto) {}
}
`;

/** Build a throwaway project and compile it exactly as a Nest repo would. */
function buildFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'silent-dto-verify-'));
  const src = path.join(root, 'src');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'thing.controller.ts'), CONTROLLER);
  fs.writeFileSync(path.join(src, 'register.dto.ts'), DTO_FILE);

  const options = {
    target: ts.ScriptTarget.ES2021,
    module: ts.ModuleKind.CommonJS,
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
    outDir: path.join(root, 'dist'),
    rootDir: src,
    strict: true,
    skipLibCheck: true,
  };

  const program = ts.createProgram(
    [path.join(src, 'thing.controller.ts'), path.join(src, 'register.dto.ts')],
    options,
  );
  const emitted = program.emit();

  const errors = ts
    .getPreEmitDiagnostics(program)
    .concat(emitted.diagnostics)
    .filter((d) => d.category === ts.DiagnosticCategory.Error)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '));
  assert.deepEqual(errors, [], 'fixture must compile cleanly');

  return root;
}

let root;
test.before(() => {
  root = buildFixture();
});
test.after(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

test('the compiled fixture is readable and metadata is scoped to its own class', () => {
  const compiled = fs.readFileSync(
    path.join(root, 'dist', 'thing.controller.js'),
    'utf8',
  );

  // `anyKeyword` exists on both classes with different signatures.
  assert.deepEqual(compiledParamtypes(compiled, 'ThingController', 'anyKeyword'), [
    'Object',
  ]);
  assert.deepEqual(compiledParamtypes(compiled, 'OtherController', 'anyKeyword'), [
    'CreateThingDto',
  ]);

  // `tsc` writes the metadata before the method name in the __decorate call, so
  // a forward scan from the name would land on the following handler.
  assert.deepEqual(compiledParamtypes(compiled, 'ThingController', 'validated'), [
    'CreateThingDto',
  ]);

  // Two parameters, body second.
  assert.deepEqual(compiledParamtypes(compiled, 'ThingController', 'bodyNotFirst'), [
    'String',
    'CreateThingDto',
  ]);

  assert.equal(compiledParamtypes(compiled, 'ThingController', 'noSuchMethod'), null);

  // The claim the whole writeup leans on, checked against the compiler rather
  // than asserted: a normal import emits the class, an inline `import()` type
  // emits Object even though both name the same DTO.
  //
  // Note the emitted reference is namespace-qualified under CommonJS. That is
  // still a class, so it must read as validated — which is why the verdict is
  // "is it a skipped builtin" rather than "is it a bare identifier".
  assert.deepEqual(compiledParamtypes(compiled, 'ThingController', 'importedDto'), [
    'register_dto_1.RegisterDto',
  ]);
  assert.deepEqual(
    compiledParamtypes(compiled, 'ThingController', 'inlineImportType'),
    ['Object'],
  );
});

test('the syntactic rule agrees with the compiler on every handler', () => {
  const report = verifyAgainstDist(root, path.join(root, 'dist'), /\.controller\.ts$/);

  assert.deepEqual(
    report.disagreements,
    [],
    `rule disagrees with tsc: ${JSON.stringify(report.disagreements, null, 2)}`,
  );
  assert.deepEqual(report.missingFiles, []);
  assert.equal(report.skipped, 0);
  assert.equal(report.checked, 14);
});

test('--verify-dist exits 0 and reports the comparison', () => {
  const r = spawnSync(process.execPath, [CLI, root, '--verify-dist'], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /matches the compiler on all 14 whole-body handler\(s\)/);
});

test('--verify-dist=<dir> honours a custom output directory', () => {
  const r = spawnSync(process.execPath, [CLI, root, '--verify-dist=dist'], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('--verify-dist fails loudly when the build is missing', () => {
  const r = spawnSync(process.execPath, [CLI, root, '--verify-dist=no-such-dir'], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /no compiled counterpart/);
  assert.match(r.stdout, /nothing to verify/);
});

test('a disagreement is detected and reported, not swallowed', () => {
  // Rewrite the compiled metadata so the compiler "claims" a validated handler
  // is Object. The rule still says validated, so the check must fail.
  const compiledPath = path.join(root, 'dist', 'thing.controller.js');
  const original = fs.readFileSync(compiledPath, 'utf8');
  const tampered = original.replace(
    /("design:paramtypes", \[CreateThingDto\])/,
    '"design:paramtypes", [Object]',
  );
  assert.notEqual(tampered, original, 'tamper pattern must match');

  fs.writeFileSync(compiledPath, tampered);
  try {
    const r = spawnSync(process.execPath, [CLI, root, '--verify-dist'], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /disagree on/);
    assert.match(r.stdout, /rule says validated; compiler emitted `Object`/);
  } finally {
    fs.writeFileSync(compiledPath, original);
  }
});
