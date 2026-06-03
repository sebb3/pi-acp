import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

test('PiAcpSession: emits agent_message_chunk for text_delta', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'hi' }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.sessionId, 's1')
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'hi' }
  })
})

test('PiAcpSession: emits agent_thought_chunk for thinking_delta', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking...' }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.sessionId, 's1')
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'thinking...' }
  })
})

test('PiAcpSession: emits tool_call + tool_call_update + completes', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } })
  proc.emit({
    type: 'tool_execution_update',
    toolCallId: 't1',
    partialResult: { content: [{ type: 'text', text: 'running' }] }
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    isError: false,
    result: { content: [{ type: 'text', text: 'done' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 3)

  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.equal((conn.updates[0]!.update as any).toolCallId, 't1')
  assert.equal((conn.updates[0]!.update as any).title, 'ls')
  assert.equal((conn.updates[0]!.update as any).kind, 'execute')
  assert.equal((conn.updates[0]!.update as any).status, 'in_progress')
  assert.equal((conn.updates[0]!.update as any).locations, undefined)
  assert.deepEqual((conn.updates[0]!.update as any).content, [{ type: 'terminal', terminalId: 't1' }])
  assert.deepEqual((conn.updates[0]!.update as any)._meta, {
    terminal_info: { terminal_id: 't1', cwd: process.cwd() }
  })
  assert.equal((conn.updates[0]!.update as any).rawInput, undefined)

  assert.equal(conn.updates[1]!.update.sessionUpdate, 'tool_call_update')
  assert.equal((conn.updates[1]!.update as any).toolCallId, 't1')
  assert.equal((conn.updates[1]!.update as any).status, 'in_progress')
  assert.equal((conn.updates[1]!.update as any).content, undefined)
  assert.deepEqual((conn.updates[1]!.update as any)._meta, {
    terminal_output: { terminal_id: 't1', data: 'running' }
  })
  assert.equal((conn.updates[1]!.update as any).rawOutput, undefined)

  assert.equal(conn.updates[2]!.update.sessionUpdate, 'tool_call_update')
  assert.equal((conn.updates[2]!.update as any).toolCallId, 't1')
  assert.equal((conn.updates[2]!.update as any).status, 'completed')
  assert.equal((conn.updates[2]!.update as any).content, undefined)
  assert.deepEqual((conn.updates[2]!.update as any)._meta, {
    terminal_output: { terminal_id: 't1', data: 'done' },
    terminal_exit: { terminal_id: 't1', exit_code: 0, signal: null }
  })
  assert.equal((conn.updates[2]!.update as any).rawOutput, undefined)
})

test('PiAcpSession: falls back to text bash output when client lacks terminal_output support', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    supportsTerminalOutput: false
  })

  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } })
  proc.emit({
    type: 'tool_execution_update',
    toolCallId: 't1',
    partialResult: { content: [{ type: 'text', text: 'running' }] }
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    isError: false,
    result: { content: [{ type: 'text', text: 'running\ndone' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 3)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.equal((conn.updates[0]!.update as any).content, undefined)
  assert.equal((conn.updates[0]!.update as any)._meta, undefined)

  assert.equal(conn.updates[1]!.update.sessionUpdate, 'tool_call_update')
  assert.equal((conn.updates[1]!.update as any)._meta, undefined)
  assert.deepEqual((conn.updates[1]!.update as any).content, [
    { type: 'content', content: { type: 'text', text: '```console\nrunning\n```' } }
  ])

  assert.equal(conn.updates[2]!.update.sessionUpdate, 'tool_call_update')
  assert.equal((conn.updates[2]!.update as any)._meta, undefined)
  assert.deepEqual((conn.updates[2]!.update as any).content, [
    { type: 'content', content: { type: 'text', text: '```console\nrunning\ndone\n```' } }
  ])
})

test('PiAcpSession: emits delayed read tool locations from pi path args', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: 'src/acp/session.ts' } })
  await new Promise(r => setTimeout(r, 0))
  assert.equal(conn.updates.length, 0)

  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    isError: false,
    result: { content: [{ type: 'text', text: 'content' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 2)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.equal((conn.updates[0]!.update as any).title, 'Read src/acp/session.ts')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: `${process.cwd()}/src/acp/session.ts` }])
})

test('PiAcpSession: emits read results as embedded resources', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-read-resource-'))
  writeFileSync(join(cwd, 'doc.md'), '# Title\n')

  new PiAcpSession({
    sessionId: 's1',
    cwd,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: 'doc.md' } })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    isError: false,
    result: { content: [{ type: 'text', text: '# Title\n' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 2)
  assert.equal(conn.updates[1]!.update.sessionUpdate, 'tool_call_update')
  assert.equal((conn.updates[1]!.update as any).status, 'completed')
  assert.deepEqual((conn.updates[1]!.update as any).content, [
    {
      type: 'content',
      content: {
        type: 'resource',
        resource: {
          uri: pathToFileURL(join(cwd, 'doc.md')).toString(),
          mimeType: 'text/markdown',
          text: '# Title\n'
        }
      }
    }
  ])
  assert.equal((conn.updates[1]!.update as any).rawOutput, undefined)
})

test('PiAcpSession: emits compact bridged read tool cards without raw input or output', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_start',
      toolCall: { id: 't1', name: 'read', arguments: { path: 'flake.nix' } }
    }
  })
  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: 'flake.nix' } })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    isError: false,
    result: {
      content: [{ type: 'text', text: 'editor buffer content' }],
      details: { acpBridge: { source: 'fs.readTextFile' } }
    }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'tool_call',
    toolCallId: 't1',
    title: 'Read flake.nix',
    kind: 'read',
    status: 'completed',
    locations: [{ path: `${process.cwd()}/flake.nix` }],
    _meta: { piAcp: { source: 'fs.readTextFile' } }
  })
})

test('PiAcpSession: truncates large non-read raw tool output for ACP clients', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const big = 'x'.repeat(9000)

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'fetch_content', args: {} })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    isError: false,
    result: { content: [{ type: 'text', text: big }] }
  })

  await new Promise(r => setTimeout(r, 0))

  const update = conn.updates[1]!.update as any
  assert.equal(update.sessionUpdate, 'tool_call_update')
  assert.equal(update.content[0].content.text.startsWith('x'.repeat(8192)), true)
  assert.equal(update.rawOutput.content[0].text.startsWith('x'.repeat(8192)), true)
  assert.match(update.content[0].content.text, /truncated 808 chars/)
  assert.match(update.rawOutput.content[0].text, /truncated 808 chars/)
})

test('PiAcpSession: suppresses repeated toolcall_delta ACP updates', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_start',
      toolCall: { id: 't1', name: 'fetch_content', arguments: { url: 'a' } }
    }
  })
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_delta',
      toolCall: { id: 't1', name: 'fetch_content', arguments: { url: 'ab' } }
    }
  })
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_delta',
      toolCall: { id: 't1', name: 'fetch_content', arguments: { url: 'abc' } }
    }
  })
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_end',
      toolCall: { id: 't1', name: 'fetch_content', arguments: { url: 'abcd' } }
    }
  })
  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'fetch_content', args: { url: 'abcd' } })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 3)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.equal(conn.updates[1]!.update.sessionUpdate, 'tool_call_update')
  assert.deepEqual((conn.updates[1]!.update as any).rawInput, { url: 'abcd' })
  assert.equal(conn.updates[2]!.update.sessionUpdate, 'tool_call_update')
  assert.equal((conn.updates[2]!.update as any).rawInput, undefined)
})

test('PiAcpSession: emits agent_message_chunk for auto_retry_start with attempt/maxAttempts and rounded delay', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_retry_start', attempt: 2, maxAttempts: 5, delayMs: 2400 })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Retrying (attempt 2/5, waiting 2s)...' }
  })
})

test('PiAcpSession: formats a positive sub-second auto_retry_start delay as waiting 1s', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 1 })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Retrying (attempt 1/3, waiting 1s)...' }
  })
})

test('PiAcpSession: falls back to a generic retry message when auto_retry_start fields are missing or malformed', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_retry_start', attempt: 'oops', maxAttempts: null, delayMs: 'bad' } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Retrying...' }
  })
})

test('PiAcpSession: omits raw errorMessage content from surfaced auto_retry_start status text', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'auto_retry_start',
    attempt: 1,
    maxAttempts: 4,
    delayMs: 1500,
    errorMessage: 'provider overloaded: 529'
  } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'agent_message_chunk')
  assert.equal((conn.updates[0]!.update as any).content.text, 'Retrying (attempt 1/4, waiting 2s)...')
  assert.equal((conn.updates[0]!.update as any).content.text.includes('provider overloaded'), false)
})

test('PiAcpSession: emits agent_message_chunk for auto_retry_end', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_retry_end' } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Retry finished, resuming.' }
  })
})

test('PiAcpSession: emits agent_message_chunk for auto_compaction_start', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_compaction_start' } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Context nearing limit, running automatic compaction...' }
  })
})

test('PiAcpSession: emits agent_message_chunk for auto_compaction_end', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_compaction_end' } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: {
      type: 'text',
      text: 'Automatic compaction finished; context was summarized to continue the session.'
    }
  })
})

test('PiAcpSession: preserves ordering when auto_retry_start is interleaved with text_delta events', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'before ' } })
  proc.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 2, delayMs: 2000 } as any)
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'after' } })

  await new Promise(r => setTimeout(r, 0))

  assert.deepEqual(
    conn.updates.map(u => u.update),
    [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'before ' } },
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Retrying (attempt 1/2, waiting 2s)...' }
      },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after' } }
    ]
  )
})

test('PiAcpSession: emits streamed tool locations from pi path args', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_start',
      toolCall: {
        id: 't1',
        name: 'write',
        arguments: { path: '/tmp/test.txt', content: 'hello' }
      }
    }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: '/tmp/test.txt' }])
})

test('PiAcpSession: emits edit tool line when oldText matches uniquely', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-lines-'))
  const filePath = join(cwd, 'a.txt')

  mkdirSync(cwd, { recursive: true })
  writeFileSync(filePath, 'one\ntwo\nneedle\nthree\n', 'utf8')

  new PiAcpSession({
    sessionId: 's1',
    cwd,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'edit',
    args: { path: 'a.txt', oldText: 'needle' }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: filePath, line: 3 }])
})

test('PiAcpSession: omits edit tool line when oldText matches multiple times', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-lines-dup-'))
  const filePath = join(cwd, 'a.txt')

  mkdirSync(cwd, { recursive: true })
  writeFileSync(filePath, 'one\nneedle\ntwo\nneedle\n', 'utf8')

  new PiAcpSession({
    sessionId: 's1',
    cwd,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't2',
    toolName: 'edit',
    args: { path: 'a.txt', oldText: 'needle' }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: filePath }])
})

test('PiAcpSession: prompt resolves end_turn on agent_end', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  const reason = await p
  assert.equal(reason, 'end_turn')
})

test('PiAcpSession: emits usage_update on agent_end from session stats', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.sessionStats = {
    cost: 0.1234,
    contextUsage: { tokens: 1500, contextWindow: 200000, percent: 0.75 }
  }

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end' })
  await p

  const usage = conn.updates.find(u => u.update.sessionUpdate === 'usage_update')
  assert.ok(usage, 'expected a usage_update notification')
  assert.deepEqual(usage!.update, {
    sessionUpdate: 'usage_update',
    used: 1500,
    size: 200000,
    cost: { amount: 0.1234, currency: 'USD' }
  })
})

test('PiAcpSession: usage_update omits cost and defaults used to 0 when tokens unavailable', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.sessionStats = { contextUsage: { tokens: null, contextWindow: 200000, percent: null } }

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end' })
  await p

  const usage = conn.updates.find(u => u.update.sessionUpdate === 'usage_update')
  assert.ok(usage, 'expected a usage_update notification')
  assert.deepEqual(usage!.update, {
    sessionUpdate: 'usage_update',
    used: 0,
    size: 200000
  })
})

test('PiAcpSession: skips usage_update when no context window is known', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.sessionStats = { cost: 0.5 }

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end' })
  await p

  assert.equal(
    conn.updates.find(u => u.update.sessionUpdate === 'usage_update'),
    undefined
  )
})

test('PiAcpSession: agent_end still resolves when session stats are unavailable', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const p = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end' })
  const reason = await p

  assert.equal(reason, 'end_turn')
  assert.equal(proc.getSessionStatsCount, 1)
  assert.equal(
    conn.updates.find(u => u.update.sessionUpdate === 'usage_update'),
    undefined
  )
})

test('PiAcpSession: re-emits startup info as the first chunk of the first prompt', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const notice = 'New version available: v0.74.0 (installed v0.73.1).'

  session.setStartupInfo(notice)
  session.sendStartupInfoIfPending()
  await new Promise(r => setTimeout(r, 0))

  const p = session.prompt('hello')
  await new Promise(r => setTimeout(r, 0))

  assert.equal(proc.prompts.length, 1)
  assert.equal(proc.prompts[0]!.message, 'hello')
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'agent_message_chunk')
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: notice }
  })
  assert.equal(conn.updates[1]!.update.sessionUpdate, 'agent_message_chunk')
  assert.deepEqual(conn.updates[1]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: notice }
  })

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })

  const reason = await p
  assert.equal(reason, 'end_turn')
})

test('PiAcpSession: cancel flips stopReason to cancelled', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const p = session.prompt('hello')
  await session.cancel()
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  const reason = await p

  assert.equal(proc.abortCount, 1)
  assert.equal(reason, 'cancelled')
})

test('PiAcpSession: queues concurrent prompt and starts it after agent_end', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const first = session.prompt('one')
  const second = session.prompt('two')

  assert.equal(proc.prompts.length, 1)
  assert.equal(proc.prompts[0]!.message, 'one')

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })

  const r1 = await first
  assert.equal(r1, 'end_turn')

  assert.equal(proc.prompts.length, 2)
  assert.equal(proc.prompts[1]!.message, 'two')

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })

  const r2 = await second
  assert.equal(r2, 'end_turn')
})

test('PiAcpSession: cancel clears queued prompts', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const first = session.prompt('one')
  const second = session.prompt('two')

  assert.equal(proc.prompts.length, 1)

  await session.cancel()
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })

  const r1 = await first
  const r2 = await second

  assert.equal(r1, 'cancelled')
  assert.equal(r2, 'cancelled')
})

test('PiAcpSession: expands /command before sending to pi', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [
      {
        name: 'hello',
        description: 'test',
        content: 'Say hello to $1',
        source: '(project)'
      }
    ]
  })

  const p = session.prompt('/hello world')
  assert.equal(proc.prompts.length, 1)
  assert.equal(proc.prompts[0]!.message, 'Say hello to world')

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })

  const reason = await p
  assert.equal(reason, 'end_turn')
})
