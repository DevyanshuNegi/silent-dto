#!/usr/bin/env node
/**
 * silent-dto — find the `@Body()` parameters where NestJS silently skipped validation.
 *
 * This is the one-shot audit front end. The ESLint rule in `rule.ts` is the one
 * you keep; both classify through `erasure.ts` so they cannot drift apart.
 *
 * THE BUG
 * -------
 * A global `ValidationPipe` only runs when the parameter's *emitted* metatype is a
 * class. NestJS's `ValidationPipe.toValidate()` returns false for
 * `String | Boolean | Number | Array | Object | Buffer | Date` and hands back the
 * raw body untouched.
 *
 * TypeScript's `emitDecoratorMetadata` writes `Object` into `design:paramtypes`
 * whenever the annotation is not a plain reference to a *value* (a class). So every
 * one of these reads as validated and is not:
 *
 *   @Body() dto: any                            -> Object
 *   @Body() body: { reason?: string }           -> Object  (type literal)
 *   @Body() dto: Partial<CreateThingDto>        -> Object  (TS utility type is not a value)
 *   @Body() payload: Record<string, unknown>    -> Object
 *   @Body() dto: import('./dto/x.dto').ThingDto -> Object  (no value binding in scope)
 *
 * The last is the nastiest: the DTO's `@IsEnum`/`@IsNumber` decorators are right
 * there in the file being pointed at, so the route reads as validated in review
 * while every check is dead at runtime.
 *
 * When it bites you lose: whitelisting (unknown keys reach the handler — and reach
 * your ORM if the body is ever spread into a `data:`), type coercion, and every
 * `@IsEnum`/range check on the DTO.
 *
 * WHY A SYNTACTIC RULE IS SAFE HERE
 * ---------------------------------
 * The authoritative signal is the compiled `__metadata("design:paramtypes", [...])`
 * in your build output. This scanner deliberately does not shell out to a build (a
 * pre-push gate cannot afford one) and does not construct a full ts.Program (a
 * whole-repo typecheck is slower than the suite it guards). It applies a
 * conservative syntactic rule to the source AST instead.
 *
 * Run `--verify-dist` to differential-test the heuristic against your own compiled
 * output. Do not take the rule on faith — check it against your compiler.
 *
 * The rule is conservative in the safe direction: anything that is not an obvious
 * bare class reference is reported. A false positive costs one baseline line; a
 * false negative is an unvalidated production endpoint.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import {
  PIPE_SKIPPED_BUILTINS,
  TYPE_ONLY_UTILITIES,
  short,
  type Erasure,
} from './erasure';

export type Finding = {
  /** Repo-relative path, e.g. `src/modules/fleet/fleet.controller.ts`. */
  file: string;
  /** 1-indexed line of the parameter. */
  line: number;
  controller: string;
  method: string;
  /** Source text of the annotation, e.g. `Partial<CreateThingDto>`. */
  annotation: string;
  /** Why it cannot validate, in one clause. */
  reason: string;
  /** Stable machine-readable form of `reason` — the shared `ErasureId`. */
  rule: string;
};

/**
 * Returns why `node` cannot carry validation metadata, or null if it can.
 *
 * The verdict vocabulary lives in `erasure.ts` and is shared with the ESLint
 * rule; this function's only job is mapping `ts.SyntaxKind` onto it.
 */
export function classify(
  node: ts.TypeNode | undefined,
  text: (n: ts.Node) => string = (n) => n.getText(),
): Erasure | null {
  if (!node) return { id: 'missingAnnotation', data: {} };

  switch (node.kind) {
    case ts.SyntaxKind.AnyKeyword:
      return { id: 'erasedKeyword', data: { annotation: 'any' } };
    case ts.SyntaxKind.UnknownKeyword:
      return { id: 'erasedKeyword', data: { annotation: 'unknown' } };
    case ts.SyntaxKind.ObjectKeyword:
      return { id: 'erasedKeyword', data: { annotation: 'object' } };
    case ts.SyntaxKind.TypeLiteral:
      return { id: 'erasedTypeLiteral', data: {} };
    case ts.SyntaxKind.ImportType: {
      const importNode = node as ts.ImportTypeNode;
      const qualifier = importNode.qualifier;
      const name = !qualifier
        ? null
        : ts.isIdentifier(qualifier)
          ? qualifier.text
          : qualifier.right.text;
      const arg = importNode.argument;
      const source =
        ts.isLiteralTypeNode(arg) && ts.isStringLiteral(arg.literal)
          ? arg.literal.text
          : null;
      return {
        id: 'erasedImportType',
        data: {
          annotation: text(node),
          name: name ?? 'the DTO',
          source: source ?? './dto',
        },
      };
    }
    case ts.SyntaxKind.UnionType:
      return { id: 'erasedComposite', data: { kind: 'union' } };
    case ts.SyntaxKind.IntersectionType:
      return { id: 'erasedComposite', data: { kind: 'intersection' } };
    case ts.SyntaxKind.ArrayType:
    case ts.SyntaxKind.TupleType:
      return { id: 'erasedArrayLike', data: { annotation: text(node) } };
    default:
      break;
  }

  if (ts.isTypeReferenceNode(node)) {
    const name = ts.isIdentifier(node.typeName)
      ? node.typeName.text
      : node.typeName.right.text;

    if (name === 'Partial') {
      const args = node.typeArguments;
      const inner = args && args.length === 1 ? text(args[0]) : null;
      return {
        id: 'erasedPartial',
        data: {
          annotation: text(node),
          name,
          inner: inner ?? 'CreateThingDto',
          suggested: inner ? `Partial${inner}` : 'PartialCreateThingDto',
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

  return {
    id: 'unrecognised',
    data: { annotation: text(node), kind: ts.SyntaxKind[node.kind] },
  };
}

function decoratorsOf(node: ts.ParameterDeclaration): readonly ts.Decorator[] {
  // ts.getDecorators is 4.8+; fall back for older toolchains.
  const anyTs = ts as unknown as {
    getDecorators?: (n: ts.Node) => readonly ts.Decorator[] | undefined;
  };
  if (typeof anyTs.getDecorators === 'function') {
    return anyTs.getDecorators(node) ?? [];
  }
  return (node as unknown as { decorators?: readonly ts.Decorator[] }).decorators ?? [];
}

/** True when the parameter carries a bare `@Body()` (whole-body, not `@Body('field')`). */
function isWholeBodyParam(param: ts.ParameterDeclaration): boolean {
  return decoratorsOf(param).some((dec) => {
    const call = dec.expression;
    if (!ts.isCallExpression(call)) return false;
    if (!ts.isIdentifier(call.expression)) return false;
    if (call.expression.text !== 'Body') return false;
    // `@Body('field')` pulls one property — the pipe is not expected to validate it.
    return call.arguments.length === 0;
  });
}

/**
 * Every whole-body `@Body()` parameter in a file, validated or not.
 *
 * `scanFile` narrows this to the failures; `--verify-dist` needs the passes too,
 * because a heuristic that only ever reports problems can't be checked for false
 * negatives — which are the expensive direction.
 */
export type BodyParam = {
  file: string;
  line: number;
  controller: string;
  method: string;
  /** Position in the method signature, to index into `design:paramtypes`. */
  paramIndex: number;
  annotation: string;
  /** null when the annotation is a bare class reference, i.e. it validates. */
  erasure: Erasure | null;
};

export function collectBodyParams(absPath: string, root: string): BodyParam[] {
  const source = fs.readFileSync(absPath, 'utf8');
  const sf = ts.createSourceFile(absPath, source, ts.ScriptTarget.Latest, true);
  const params: BodyParam[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      const controller = node.name.text;

      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || !member.name) continue;
        const method = member.name.getText(sf);

        member.parameters.forEach((param, paramIndex) => {
          if (!isWholeBodyParam(param)) return;

          const { line } = sf.getLineAndCharacterOfPosition(param.getStart(sf));
          params.push({
            file: path.relative(root, absPath),
            line: line + 1,
            controller,
            method,
            paramIndex,
            annotation: param.type ? param.type.getText(sf) : '(none)',
            erasure: classify(param.type, (n) => n.getText(sf)),
          });
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return params;
}

export function scanFile(absPath: string, root: string): Finding[] {
  return collectBodyParams(absPath, root)
    .filter((p) => p.erasure !== null)
    .map((p) => ({
      file: p.file,
      line: p.line,
      controller: p.controller,
      method: p.method,
      annotation: p.annotation,
      reason: short(p.erasure!),
      rule: p.erasure!.id,
    }));
}

export function walk(dir: string, match: RegExp, acc: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(full, match, acc);
    } else if (match.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

export function scan(root: string, pattern: RegExp): Finding[] {
  return walk(root, pattern)
    .flatMap((file) => scanFile(file, root))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/* ------------------------------------------------------------------ *
 * Differential verification against compiled output.
 *
 * This is the part that makes the heuristic trustworthy rather than
 * plausible. It reads the real `design:paramtypes` your compiler emitted
 * and reports where the syntactic rule and the compiler disagree.
 * ------------------------------------------------------------------ */

export type Verdict = 'validated' | 'NOT validated';

export type Disagreement = {
  file: string;
  controller: string;
  method: string;
  annotation: string;
  syntacticVerdict: Verdict;
  compiledVerdict: Verdict;
  /** The compiler's own entry, e.g. `Object`, for the report. */
  compiledMetatype: string;
};

export type VerifyReport = {
  /** Handlers compared against compiled output. */
  checked: number;
  /** Handlers whose compiled form could not be located. */
  skipped: number;
  disagreements: Disagreement[];
  /** Source files for which no compiled counterpart was found. */
  missingFiles: string[];
};

/**
 * Split a `design:paramtypes` array body on its top-level commas.
 *
 * Entries are not always bare identifiers — `typeof import("./x").Foo` is common —
 * so a plain `.split(',')` would shear them apart.
 */
function splitTopLevel(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';

  for (let i = 0; i < list.length; i++) {
    const ch = list[i];

    if (quote) {
      current += ch;
      if (ch === quote && list[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/**
 * Read the emitted `design:paramtypes` for one compiled handler.
 *
 * `tsc` emits the metadata *before* the method name inside the `__decorate` call:
 *
 *   __decorate([
 *       (0, common_1.Patch)(':id'),
 *       __param(1, (0, common_1.Body)()),
 *       __metadata("design:paramtypes", [String, Object]),
 *   ], FleetController.prototype, "update", null);
 *
 * so the block has to be matched as a whole rather than scanned forward from the
 * method name — scanning forward lands on the *next* handler's metadata.
 */
export function compiledParamtypes(
  distSource: string,
  controller: string,
  method: string,
): string[] | null {
  const blocks = distSource.matchAll(
    /__decorate\(\[([\s\S]*?)\],\s*([\w$]+)\.prototype,\s*"([^"]+)"/g,
  );

  for (const block of blocks) {
    const [, body, cls, name] = block;
    if (cls !== controller || name !== method) continue;
    const meta = body.match(/design:paramtypes",\s*\[([\s\S]*?)\]\s*\)/);
    if (!meta) return null;
    return splitTopLevel(meta[1]);
  }
  return null;
}

/** What the compiler's emitted metatype means for the pipe. */
export function verdictForMetatype(metatype: string): Verdict {
  const bare = metatype.replace(/^typeof\s+/, '').trim();
  if (!bare || bare === 'void 0' || bare === 'undefined') return 'NOT validated';
  return PIPE_SKIPPED_BUILTINS.has(bare) ? 'NOT validated' : 'validated';
}

/**
 * Candidate compiled paths for a source file. Layouts vary (`src/` stripped or
 * kept, nested `dist/src/`), so try the common ones rather than demand config.
 */
function compiledCandidates(relSource: string, distDir: string): string[] {
  const asJs = relSource.replace(/\.ts$/, '.js');
  const withoutSrc = asJs.replace(/^src[\\/]/, '');
  return [
    path.join(distDir, withoutSrc),
    path.join(distDir, asJs),
    path.join(distDir, 'src', withoutSrc),
  ];
}

/**
 * Differential-test the syntactic rule against the compiler's own output.
 *
 * This is the part that makes the heuristic trustworthy rather than plausible:
 * it reads the real `design:paramtypes` your build emitted and reports every
 * handler where the rule and the compiler disagree.
 */
export function verifyAgainstDist(
  root: string,
  distDir: string,
  pattern: RegExp,
): VerifyReport {
  const report: VerifyReport = {
    checked: 0,
    skipped: 0,
    disagreements: [],
    missingFiles: [],
  };

  for (const file of walk(root, pattern)) {
    const params = collectBodyParams(file, root);
    if (!params.length) continue;

    const compiledPath = compiledCandidates(params[0].file, distDir).find((p) =>
      fs.existsSync(p),
    );
    if (!compiledPath) {
      report.missingFiles.push(params[0].file);
      report.skipped += params.length;
      continue;
    }

    const distSource = fs.readFileSync(compiledPath, 'utf8');

    for (const param of params) {
      const paramtypes = compiledParamtypes(distSource, param.controller, param.method);
      const metatype = paramtypes?.[param.paramIndex];
      if (metatype === undefined) {
        report.skipped++;
        continue;
      }

      report.checked++;
      const syntacticVerdict: Verdict =
        param.erasure === null ? 'validated' : 'NOT validated';
      const compiledVerdict = verdictForMetatype(metatype);

      if (syntacticVerdict !== compiledVerdict) {
        report.disagreements.push({
          file: param.file,
          controller: param.controller,
          method: param.method,
          annotation: param.annotation,
          syntacticVerdict,
          compiledVerdict,
          compiledMetatype: metatype,
        });
      }
    }
  }

  return report;
}

function formatFinding(f: Finding): string {
  return (
    `  ${f.file}:${f.line}\n` +
    `    ${f.controller}.${f.method}()  @Body() ${f.annotation}\n` +
    `    ↳ ${f.reason}\n`
  );
}

/** `--flag=value`, or null when absent. */
function flagValue(args: string[], name: string): string | null {
  const prefix = `${name}=`;
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

const PATTERN = /\.controller\.ts$/;

function runVerifyDist(root: string, distDir: string): never {
  const report = verifyAgainstDist(root, distDir, PATTERN);

  if (report.missingFiles.length) {
    console.log(
      `silent-dto: no compiled counterpart under ${path.relative(root, distDir) || distDir} for ` +
        `${report.missingFiles.length} file(s). Build first, then re-run.\n`,
    );
    for (const f of report.missingFiles.slice(0, 10)) console.log(`  ${f}`);
    if (report.missingFiles.length > 10) {
      console.log(`  … and ${report.missingFiles.length - 10} more`);
    }
    console.log('');
  }

  if (!report.checked) {
    console.log(
      'silent-dto: nothing to verify — no compiled handler metadata found.\n' +
        'Check that the build output is present and that `emitDecoratorMetadata` is on.',
    );
    process.exit(1);
  }

  if (!report.disagreements.length) {
    console.log(
      `silent-dto: the syntactic rule matches the compiler on all ${report.checked} ` +
        `whole-body handler(s)${report.skipped ? `, ${report.skipped} skipped` : ''}. ✅`,
    );
    process.exit(0);
  }

  console.log(
    `\nsilent-dto: the rule and your compiler disagree on ` +
      `${report.disagreements.length} of ${report.checked} handler(s).\n`,
  );
  for (const d of report.disagreements) {
    console.log(`  ${d.file}`);
    console.log(`    ${d.controller}.${d.method}()  @Body() ${d.annotation}`);
    console.log(
      `    ↳ rule says ${d.syntacticVerdict}; compiler emitted \`${d.compiledMetatype}\` ` +
        `(${d.compiledVerdict})\n`,
    );
  }
  console.log('The compiler is authoritative. Please open an issue with the case above.\n');
  process.exit(1);
}

function main(): void {
  const args = process.argv.slice(2);
  const root = path.resolve(
    args.find((a) => !a.startsWith('-')) ?? process.cwd(),
  );
  const jsonOut = args.includes('--json');
  const writeBaseline = args.includes('--baseline');
  const baselinePath = path.join(root, '.silent-dto-baseline.json');

  if (args.some((a) => a === '--verify-dist' || a.startsWith('--verify-dist='))) {
    const dist = flagValue(args, '--verify-dist') ?? 'dist';
    runVerifyDist(root, path.resolve(root, dist));
  }

  const findings = scan(root, PATTERN);

  if (jsonOut) {
    process.stdout.write(JSON.stringify(findings, null, 2) + '\n');
    process.exit(findings.length ? 1 : 0);
  }

  if (writeBaseline) {
    const keys = findings.map((f) => `${f.file}:${f.controller}.${f.method}`).sort();
    fs.writeFileSync(baselinePath, JSON.stringify(keys, null, 2) + '\n');
    console.log(
      `silent-dto: wrote ${keys.length} known finding(s) to ${path.relative(root, baselinePath)}`,
    );
    console.log('Existing debt is now baselined. New findings will fail the check.');
    process.exit(0);
  }

  let baseline: Set<string> | null = null;
  if (fs.existsSync(baselinePath)) {
    baseline = new Set(JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as string[]);
  }

  const fresh = baseline
    ? findings.filter((f) => !baseline!.has(`${f.file}:${f.controller}.${f.method}`))
    : findings;

  if (!findings.length) {
    console.log('silent-dto: every @Body() parameter can carry validation metadata. ✅');
    process.exit(0);
  }

  if (baseline && !fresh.length) {
    console.log(
      `silent-dto: ${findings.length} known finding(s), 0 new. ✅  (baselined)`,
    );
    process.exit(0);
  }

  const shown = baseline ? fresh : findings;
  console.log(
    `\nsilent-dto: ${shown.length} @Body() parameter(s) where ValidationPipe does nothing.\n`,
  );
  for (const f of shown) console.log(formatFinding(f));

  console.log('Each of these accepts unknown keys and skips every class-validator');
  console.log('decorator on the DTO. Fix by annotating with a bare class reference,');
  console.log("or run with --baseline to accept current debt and gate against new.\n");
  console.log('To keep this from coming back, enable the lint rule instead — it runs');
  console.log('on every save and in CI, and explains the fix in the error message:');
  console.log("  eslint.config.mjs →  import silentDto from 'silent-dto';");
  console.log('                       export default [silentDto.configs.recommended];\n');

  process.exit(1);
}

if (require.main === module) main();
