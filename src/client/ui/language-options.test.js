import test from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGE_OPTIONS } from './language-options.js';

const EXPECTED_OPTIONS = [
  ['en', 'English'], ['th', 'ไทย'], ['zh', '简体中文'], ['ja', '日本語'],
  ['ko', '한국어'], ['es', 'Español'], ['pt', 'Português'], ['de', 'Deutsch'],
  ['fr', 'Français'], ['vi', 'Tiếng Việt'], ['id', 'Bahasa Indonesia'],
];
test('language choices keep their observable order, native labels and frozen entries', () => {
  assert.deepEqual(LANGUAGE_OPTIONS.map(({ code, name }) => [code, name]), EXPECTED_OPTIONS);
  assert.ok(Object.isFrozen(LANGUAGE_OPTIONS));
  assert.ok(LANGUAGE_OPTIONS.every(Object.isFrozen));
});
