/**
 * The CLI front end: exit codes and the baseline workflow.
 *
 * Exit codes are the whole interface in CI, and the baseline is what makes the
 * tool adoptable on a codebase that already has findings — so both get covered
 * end to end through a real process rather than by calling `main()`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'dist', 'scan.js');

const DIRTY = `import { Body, Patch, Post } from '@nestjs/common';

class ThingController {
  @Post()
  create(@Body() dto: CreateThingDto) {}

  @Patch()
  update(@Body() dto: Partial<CreateThingDto>) {}

  @Post()
  ingest(@Body() payload: Record<string, unknown>) {}
}
`;

const CLEAN = `import { Body, Post } from '@nestjs/common';

class ThingController {
  @Post()
  create(@Body() dto: CreateThingDto) {}
}
`;

/** A throwaway repo root containing the given `name -> source` controllers. */
function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'silent-dto-cli-'));
  for (const [name, source] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), source);
  }
  return dir;
}

function run(dir, ...args) {
  const r = spawnSync(process.execPath, [CLI, dir, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('the published bin keeps its shebang, or npx cannot execute it', () => {
  assert.match(fs.readFileSync(CLI, 'utf8').split('\n')[0], /^#!\/usr\/bin\/env node$/);
});

test('a clean codebase exits 0', () => {
  const dir = repo({ 'thing.controller.ts': CLEAN });
  const { status, stdout } = run(dir);
  assert.equal(status, 0);
  assert.match(stdout, /every @Body\(\) parameter can carry validation metadata/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('findings exit 1 and name the file, handler and remedy', () => {
  const dir = repo({ 'thing.controller.ts': DIRTY });
  const { status, stdout } = run(dir);
  assert.equal(status, 1);
  assert.match(stdout, /2 @Body\(\) parameter\(s\) where ValidationPipe does nothing/);
  assert.match(stdout, /ThingController\.update\(\)/);
  assert.match(stdout, /ThingController\.ingest\(\)/);
  // The valid handler must not be reported.
  assert.doesNotMatch(stdout, /ThingController\.create\(\)/);
  // The CLI points at the lint rule, since a one-shot audit does not stay fixed.
  assert.match(stdout, /eslint\.config\.mjs/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--json emits machine-readable findings carrying the shared verdict id', () => {
  const dir = repo({ 'thing.controller.ts': DIRTY });
  const { status, stdout } = run(dir, '--json');
  assert.equal(status, 1);
  const findings = JSON.parse(stdout);
  assert.equal(findings.length, 2);
  assert.deepEqual(
    findings.map((f) => f.rule),
    ['erasedPartial', 'erasedUtility'],
  );
  assert.equal(findings[0].controller, 'ThingController');
  assert.equal(findings[0].method, 'update');
  assert.equal(findings[0].annotation, 'Partial<CreateThingDto>');
  assert.equal(typeof findings[0].line, 'number');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--baseline accepts current debt, then gates only new findings', () => {
  const dir = repo({ 'thing.controller.ts': DIRTY });

  const written = run(dir, '--baseline');
  assert.equal(written.status, 0);
  assert.match(written.stdout, /wrote 2 known finding\(s\)/);
  assert.ok(fs.existsSync(path.join(dir, '.silent-dto-baseline.json')));

  // Same code, now baselined: passes.
  const after = run(dir);
  assert.equal(after.status, 0);
  assert.match(after.stdout, /2 known finding\(s\), 0 new/);

  // A newly introduced hole is not in the baseline, so it fails.
  fs.writeFileSync(
    path.join(dir, 'other.controller.ts'),
    `import { Body, Post } from '@nestjs/common';\n\nclass OtherController {\n  @Post()\n  fresh(@Body() dto: any) {}\n}\n`,
  );
  const regressed = run(dir);
  assert.equal(regressed.status, 1);
  assert.match(regressed.stdout, /1 @Body\(\) parameter\(s\)/);
  assert.match(regressed.stdout, /OtherController\.fresh\(\)/);
  assert.doesNotMatch(regressed.stdout, /ThingController/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('only .controller.ts files are walked', () => {
  const dir = repo({ 'thing.service.ts': DIRTY, 'thing.controller.ts': CLEAN });
  const { status } = run(dir);
  assert.equal(status, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
