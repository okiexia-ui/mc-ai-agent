const assert = require('node:assert/strict')
const { test } = require('node:test')
const { parseAction } = require('../src/brain')

const fallback = {
  action: 'say',
  args: { text: '（我没太听懂，可以换种说法吗）' },
}

test('parses a valid action and preserves its arguments', () => {
  assert.deepEqual(parseAction('{"action":"collect","args":{"block":"oak_log","count":5}}'), {
    action: 'collect', args: { block: 'oak_log', count: 5 },
  })
})

test('defaults missing arguments to an empty object', () => {
  assert.deepEqual(parseAction('{"action":"stop"}'), { action: 'stop', args: {} })
})

test('accepts fenced JSON with surrounding whitespace', () => {
  for (const fence of ['```json', '```JSON', '```']) {
    assert.deepEqual(parseAction(` \n${fence}\n{"action":"inventory","args":{}}\n\`\`\`\n `), {
      action: 'inventory', args: {},
    })
  }
})

test('accepts explanatory text around one JSON object', () => {
  assert.deepEqual(parseAction('Next action: {"action":"say","args":{"text":"你好"}} Done.'), {
    action: 'say', args: { text: '你好' },
  })
})

test('returns the fallback for empty or whitespace-only input', () => {
  for (const input of ['', ' \n\t ', '```json\n\n```']) {
    assert.deepEqual(parseAction(input), fallback)
  }
})

test('returns the fallback for malformed JSON or a missing action', () => {
  for (const input of ['not JSON', '{', '{"action":}', '{"action":"stop",}', '{}', '{"args":{}}']) {
    assert.deepEqual(parseAction(input), fallback)
  }
})
