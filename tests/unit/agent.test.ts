import test from 'node:test'
import assert from 'node:assert/strict'
import { parseToolCalls } from '../../pharo-agent/agent.ts'
import { extractToolCalls, toNativeMessages, toTextMessages } from '../../pharo-agent/tool-calls.ts'
import type { ChatMessage } from '../../pharo-agent/types.ts'

const known = ['pharo_define_class', 'pharo_compile', 'pharo_inspect', 'pharo_save', 'file_read']

test('parses single fallback tool call', () => {
  assert.deepEqual(parseToolCalls('{"tool":"pharo_inspect","arguments":{"target":"Object"}}'), [
    { name: 'pharo_inspect', arguments: { target: 'Object' } },
  ])
})

test('parses final shorthand', () => {
  assert.deepEqual(parseToolCalls('```json\n{"final":"done"}\n```'), [
    { name: 'final', arguments: { answer: 'done' } },
  ])
})

test('parses multiple tool calls', () => {
  assert.equal(parseToolCalls('{"tools":[{"tool":"list_dir","arguments":{}},{"tool":"memory_read","arguments":{}}]}').length, 2)
})

test('parses the "function" key that small Qwen models write', () => {
  assert.deepEqual(parseToolCalls('```json\n{\n  "function": "pharo_inspect",\n  "arguments": {\n    "pattern": "Counter"\n  }\n}\n```', known), [
    { name: 'pharo_inspect', arguments: { pattern: 'Counter' } },
  ])
})

test('parses the OpenAI shape with string arguments', () => {
  assert.deepEqual(parseToolCalls('{"type":"function","function":{"name":"file_read","arguments":"{\\"path\\":\\"a.st\\"}"}}', known), [
    { name: 'file_read', arguments: { path: 'a.st' } },
  ])
})

test('parses Qwen <tool_call> tags, several per reply', () => {
  const text = '<tool_call>\n{"name": "pharo_save", "arguments": {}}\n</tool_call>\n<tool_call>\n{"name": "file_read", "arguments": {"path": "x"}}\n</tool_call>'
  assert.deepEqual(parseToolCalls(text, known).map(call => call.name), ['pharo_save', 'file_read'])
})

test('parses every fenced call in a reply that explains itself', () => {
  const text = `To create the package:

1. Define the class

\`\`\`json
{ "function": "pharo_define_class", "arguments": { "name": "Counter", "package": "Counter", "slots": ["value"], "superclass": "Object" } }
\`\`\`

\`\`\`json
{ "function": "pharo_compile", "arguments": { "className": "Counter", "source": "increment\\n\\tvalue := value + 1" } }
\`\`\`
`
  const extracted = extractToolCalls(text, known)
  assert.deepEqual(extracted.calls.map(call => call.name), ['pharo_define_class', 'pharo_compile'])
  assert.equal(extracted.calls[0]!.arguments.name, 'Counter', 'arguments named "name" are not mistaken for the tool')
  assert.match(extracted.narration, /To create the package/)
  assert.doesNotMatch(extracted.narration, /```/)
})

test('repairs raw newlines inside strings (method source)', () => {
  const text = '{"name": "pharo_compile", "arguments": {"className": "Counter", "source": "value\n\t^ value",}}'
  assert.deepEqual(parseToolCalls(text, known), [
    { name: 'pharo_compile', arguments: { className: 'Counter', source: 'value\n\t^ value' } },
  ])
})

test('JSON in an answer that does not name a known tool is not a call', () => {
  const answer = 'Your config could look like:\n```json\n{"name": "Counter", "arguments": {}}\n```'
  assert.deepEqual(parseToolCalls(answer, known), [])
  assert.equal(extractToolCalls(answer, known).malformed, undefined)
})

test('flags a call that names a tool but is not valid JSON', () => {
  const extracted = extractToolCalls('{"function": "pharo_compile", "arguments": {"source": "a" "b"}}', known)
  assert.deepEqual(extracted.calls, [])
  assert.match(extracted.malformed ?? '', /pharo_compile/)
})

const history: ChatMessage[] = [
  { role: 'system', content: 'You are Pharo Agent.' },
  { role: 'user', content: 'read it' },
  { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'file_read', arguments: '{"path":"a"}' } }] },
  { role: 'tool', tool_call_id: 'call_1', name: 'file_read', content: '{"ok":true}' },
]

test('text mode rewrites native history and adds the protocol once', () => {
  const tools = [{ name: 'file_read', description: 'Read a file.', readOnly: true, inputSchema: { type: 'object' as const, properties: { path: { type: 'string' } }, required: ['path'] } }]
  const text = toTextMessages(history, tools)
  assert.match(text[0]!.content, /file_read\(path: string\)/)
  assert.equal(text[2]!.content, '{"name":"file_read","arguments":{"path":"a"}}')
  assert.deepEqual(text[3], { role: 'user', content: 'Tool result for file_read:\n{"ok":true}' })
  assert.ok(text.every(message => !message.tool_calls && !message.tool_call_id))
})

test('native mode keeps tool_calls and tool_call_id', () => {
  const native = toNativeMessages(history)
  assert.equal(native[2]!.tool_calls?.[0]?.id, 'call_1')
  assert.deepEqual(native[3], { role: 'tool', content: '{"ok":true}', tool_call_id: 'call_1' })
})

test('a call to a made-up tool is flagged, not shown as narration', () => {
  const extracted = extractToolCalls('{"name": "pharo_start", "arguments": {"headless": false}}', known)
  assert.deepEqual(extracted.calls, [])
  assert.match(extracted.malformed ?? '', /no tool named pharo_start/)
})
