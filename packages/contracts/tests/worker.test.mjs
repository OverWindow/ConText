import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateWorkerInput, validateWorkerResult } from '../../../apps/desktop/core/contracts/src/index.js';

const fixtures = JSON.parse(readFileSync(new URL('../fixtures/worker-v2.json', import.meta.url)));
for (const fixture of fixtures) test(`shared Python/TypeScript worker fixture: ${fixture.name}`, () => {
  const validate = fixture.kind === 'input' ? validateWorkerInput : validateWorkerResult;
  if (fixture.valid) assert.deepEqual(validate(fixture.value), fixture.value);
  else assert.throws(() => validate(fixture.value));
});
