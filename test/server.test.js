const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { safeName, workerSource } = require('../server');

test('safeName makes valid Cloudflare script identifiers', () => {
  assert.equal(safeName('My Persian Bot!'), 'my-persian-bot');
  assert.equal(safeName(''), 'monli-bot');
  assert.ok(safeName('A'.repeat(100)).length <= 55);
});

test('generated Worker is valid JavaScript and includes D1-backed conversation context', () => {
  const source = workerSource().replace('export default {', 'const worker = {');
  assert.doesNotThrow(() => new vm.Script(source));
  assert.match(source, /chat_messages/);
  assert.match(source, /chat\/completions/);
  assert.match(source, /TELEGRAM_BOT_TOKEN/);
  assert.match(source, /TELEGRAM_WEBHOOK_SECRET/);
});
