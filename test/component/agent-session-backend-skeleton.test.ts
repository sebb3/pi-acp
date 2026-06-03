import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { SessionManager } from '../../src/acp/session.js'
import { AgentSessionProcess } from '../../src/pi-agent-session/process.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

class FakeAgentSession {
  readonly sessionId = 'agent-session-1'
  readonly sessionFile = undefined
  readonly model = { provider: 'test', id: 'model', modelId: 'model', name: 'model' }
  readonly modelRegistry = {
    getAvailable: () => [this.model],
    find: (provider: string, modelId: string) =>
      provider === this.model.provider && modelId === this.model.id ? this.model : undefined
  }
  readonly thinkingLevel = 'medium'
  readonly steeringMode = 'all'
  readonly followUpMode = 'all'
  readonly autoCompactionEnabled = true
  readonly messages: any[] = []
  readonly agent = {
    state: { tools: [{ name: 'read', source: 'builtin' }, { name: 'write', source: 'builtin' }, { name: 'bash' }] as any[] }
  }
  readonly prompts: Array<{ text: string; options: unknown }> = []
  abortCount = 0
  modelSelections: unknown[] = []
  disposed = false
  private listeners: Array<(event: Record<string, unknown>) => void> = []

  subscribe(listener: (event: Record<string, unknown>) => void): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener)
    }
  }

  emit(event: Record<string, unknown>): void {
    for (const listener of this.listeners) listener(event)
  }

  async prompt(text: string, options: unknown): Promise<void> {
    this.prompts.push({ text, options })
  }

  async abort(): Promise<void> {
    this.abortCount += 1
  }

  async setModel(model: unknown): Promise<void> {
    this.modelSelections.push(model)
  }

  dispose(): void {
    this.disposed = true
  }
}

test('PiAcpAgent: in-process AgentSession backend can create, prompt, stream text, and finish without Pi RPC spawn', async () => {
  const conn = new FakeAgentSideConnection()
  const fakeSession = new FakeAgentSession()
  let spawnCount = 0
  let spawnCwd = ''

  const sessions = new SessionManager({
    async spawnProcess(params) {
      spawnCount += 1
      spawnCwd = params.cwd
      return new AgentSessionProcess(fakeSession)
    }
  })

  const agent = new PiAcpAgent(asAgentConn(conn), { sessionManager: sessions })

  const created = await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)
  assert.equal(created.sessionId, 'agent-session-1')
  assert.equal(spawnCount, 1)
  assert.equal(spawnCwd, process.cwd())

  const promptPromise = agent.prompt({
    sessionId: created.sessionId,
    prompt: [{ type: 'text', text: 'hello from acp' }]
  } as any)

  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(fakeSession.prompts.length, 1)
  assert.equal(fakeSession.prompts[0]!.text, 'hello from acp')

  fakeSession.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'hello back' }
  })
  fakeSession.emit({ type: 'agent_end', messages: [], willRetry: false })

  assert.deepEqual(await promptPromise, { stopReason: 'end_turn' })

  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(
    conn.updates.some(update => {
      const u = update.update as any
      return u.sessionUpdate === 'agent_message_chunk' && u.content?.text === 'hello back'
    }),
    true
  )
})

test('PiAcpAgent: in-process AgentSession backend can revive a known session file and continue prompting', async () => {
  const conn = new FakeAgentSideConnection()
  const fakeSession = new FakeAgentSession()
  let revivedSessionPath = ''

  const sessions = new SessionManager({
    async spawnProcess(params) {
      revivedSessionPath = params.sessionPath ?? ''
      return new AgentSessionProcess(fakeSession)
    }
  })

  const agent = new PiAcpAgent(asAgentConn(conn), { sessionManager: sessions })
  ;(agent as any).store.upsert({ sessionId: 'revivable', cwd: process.cwd(), sessionFile: '/tmp/revivable.jsonl' })

  const promptPromise = agent.prompt({
    sessionId: 'revivable',
    prompt: [{ type: 'text', text: 'continue please' }]
  } as any)

  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(revivedSessionPath, '/tmp/revivable.jsonl')
  assert.equal(fakeSession.prompts[0]!.text, 'continue please')

  fakeSession.emit({ type: 'agent_end', messages: [], willRetry: false })
  assert.deepEqual(await promptPromise, { stopReason: 'end_turn' })
})

test('AgentSessionProcess: maps model selection through the in-process session model registry', async () => {
  const fakeSession = new FakeAgentSession()
  const proc = new AgentSessionProcess(fakeSession)

  await proc.setModel('test', 'model')

  assert.deepEqual(fakeSession.modelSelections, [fakeSession.model])
})

test('AgentSessionProcess: replaces read with an ACP-backed read tool when the client supports it', async () => {
  const fakeSession = new FakeAgentSession()
  const readRequests: any[] = []
  const conn = {
    async readTextFile(params: any) {
      readRequests.push(params)
      return { content: 'from zed fs' }
    }
  }
  let readOperations: any = null

  await AgentSessionProcess.spawn(
    {
      cwd: process.cwd(),
      conn: conn as any,
      clientCapabilities: { fs: { readTextFile: true } }
    },
    {
      createAgentSession: async options => {
        assert.equal((options as any).customTools?.[0]?.source, 'acp')
        return { session: fakeSession }
      },
      createReadToolDefinition: (_cwd, options) => {
        readOperations = options?.operations
        return { name: 'read', source: 'acp' } as any
      }
    }
  )

  assert.equal(fakeSession.agent.state.tools[0]!.source, 'acp')
  assert.equal(fakeSession.agent.state.tools[1]!.name, 'write')
  assert.equal(fakeSession.agent.state.tools[2]!.name, 'bash')
  assert.equal((await readOperations.readFile('/tmp/file.txt')).toString('utf8'), 'from zed fs')
  assert.deepEqual(readRequests, [{ sessionId: 'agent-session-1', path: '/tmp/file.txt' }])
})

test('AgentSessionProcess: replaces write with an ACP-backed write tool when the client supports it', async () => {
  const fakeSession = new FakeAgentSession()
  const writeRequests: any[] = []
  const conn = {
    async writeTextFile(params: any) {
      writeRequests.push(params)
      return {}
    }
  }
  let writeOperations: any = null

  await AgentSessionProcess.spawn(
    {
      cwd: process.cwd(),
      conn: conn as any,
      clientCapabilities: { fs: { writeTextFile: true } }
    },
    {
      createAgentSession: async options => {
        assert.equal((options as any).customTools?.[0]?.source, 'acp')
        return { session: fakeSession }
      },
      createWriteToolDefinition: (_cwd, options) => {
        writeOperations = options?.operations
        return { name: 'write', source: 'acp' } as any
      }
    }
  )

  assert.equal(fakeSession.agent.state.tools[0]!.name, 'read')
  assert.equal(fakeSession.agent.state.tools[1]!.source, 'acp')
  assert.equal(fakeSession.agent.state.tools[2]!.name, 'bash')
  await writeOperations.mkdir('/tmp')
  await writeOperations.writeFile('/tmp/file.txt', 'hello from acp')
  assert.deepEqual(writeRequests, [{ sessionId: 'agent-session-1', path: '/tmp/file.txt', content: 'hello from acp' }])
})

test('AgentSessionProcess: keeps native read/write when the client does not advertise fs support', async () => {
  const fakeSession = new FakeAgentSession()

  await AgentSessionProcess.spawn(
    {
      cwd: process.cwd(),
      conn: {} as any,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }
    },
    {
      createAgentSession: async options => {
        assert.equal((options as any).customTools, undefined)
        return { session: fakeSession }
      },
      createReadToolDefinition: () => ({ name: 'read', source: 'acp' }) as any,
      createWriteToolDefinition: () => ({ name: 'write', source: 'acp' }) as any
    }
  )

  assert.equal(fakeSession.agent.state.tools[0]!.source, 'builtin')
  assert.equal(fakeSession.agent.state.tools[1]!.source, 'builtin')
})

test('PiAcpAgent: in-process AgentSession backend maps representative tool lifecycle events', async () => {
  const conn = new FakeAgentSideConnection()
  const fakeSession = new FakeAgentSession()
  const sessions = new SessionManager({
    async spawnProcess() {
      return new AgentSessionProcess(fakeSession)
    }
  })
  const agent = new PiAcpAgent(asAgentConn(conn), { sessionManager: sessions })

  await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)
  fakeSession.emit({ type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'read', args: { path: 'package.json' } })
  fakeSession.emit({
    type: 'tool_execution_update',
    toolCallId: 'read-1',
    partialResult: { content: [{ type: 'text', text: 'reading' }] }
  })
  fakeSession.emit({
    type: 'tool_execution_end',
    toolCallId: 'read-1',
    isError: false,
    result: { content: [{ type: 'text', text: 'done' }] }
  })

  await new Promise(resolve => setTimeout(resolve, 0))
  const toolUpdates = conn.updates.map(u => u.update as any).filter(u => u.toolCallId === 'read-1')

  assert.equal(toolUpdates.length, 3)
  assert.deepEqual(toolUpdates[0], {
    sessionUpdate: 'tool_call',
    toolCallId: 'read-1',
    title: 'read',
    kind: 'read',
    status: 'in_progress',
    locations: [{ path: `${process.cwd()}/package.json` }],
    rawInput: { path: 'package.json' }
  })
  assert.equal(toolUpdates[1].sessionUpdate, 'tool_call_update')
  assert.equal(toolUpdates[1].status, 'in_progress')
  assert.deepEqual(toolUpdates[1].content, [{ type: 'content', content: { type: 'text', text: 'reading' } }])
  assert.equal(toolUpdates[2].sessionUpdate, 'tool_call_update')
  assert.equal(toolUpdates[2].status, 'completed')
  assert.deepEqual(toolUpdates[2].content, [{ type: 'content', content: { type: 'text', text: 'done' } }])
})

test('PiAcpAgent: in-process AgentSession backend keeps bash terminal-style ACP cards', async () => {
  const conn = new FakeAgentSideConnection()
  const fakeSession = new FakeAgentSession()
  const sessions = new SessionManager({
    async spawnProcess() {
      return new AgentSessionProcess(fakeSession)
    }
  })
  const agent = new PiAcpAgent(asAgentConn(conn), { sessionManager: sessions })

  await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)
  fakeSession.emit({ type: 'tool_execution_start', toolCallId: 'bash-1', toolName: 'bash', args: { command: 'echo hi' } })
  fakeSession.emit({
    type: 'tool_execution_update',
    toolCallId: 'bash-1',
    partialResult: { content: [{ type: 'text', text: 'hi\\n' }] }
  })
  fakeSession.emit({
    type: 'tool_execution_end',
    toolCallId: 'bash-1',
    isError: false,
    result: { content: [{ type: 'text', text: 'hi\\n' }], details: { exitCode: 0 } }
  })

  await new Promise(resolve => setTimeout(resolve, 0))
  const toolUpdates = conn.updates.map(u => u.update as any).filter(u => u.toolCallId === 'bash-1')

  assert.equal(toolUpdates.length, 3)
  assert.equal(toolUpdates[0].sessionUpdate, 'tool_call')
  assert.equal(toolUpdates[0].kind, 'execute')
  assert.equal(toolUpdates[0].title, 'echo hi')
  assert.deepEqual(toolUpdates[0].content, [{ type: 'terminal', terminalId: 'bash-1' }])
  assert.deepEqual(toolUpdates[0]._meta, { terminal_info: { terminal_id: 'bash-1', cwd: process.cwd() } })
  assert.deepEqual(toolUpdates[1]._meta, { terminal_output: { terminal_id: 'bash-1', data: 'hi\\n' } })
  assert.deepEqual(toolUpdates[2]._meta, { terminal_exit: { terminal_id: 'bash-1', exit_code: 0, signal: null } })
})

test('PiAcpAgent: in-process AgentSession backend maps cancellation to cancelled stop reason', async () => {
  const conn = new FakeAgentSideConnection()
  const fakeSession = new FakeAgentSession()

  const sessions = new SessionManager({
    async spawnProcess() {
      return new AgentSessionProcess(fakeSession)
    }
  })

  const agent = new PiAcpAgent(asAgentConn(conn), { sessionManager: sessions })
  const created = await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)

  const promptPromise = agent.prompt({
    sessionId: created.sessionId,
    prompt: [{ type: 'text', text: 'please work' }]
  } as any)

  await agent.cancel({ sessionId: created.sessionId } as any)
  fakeSession.emit({ type: 'agent_end', messages: [], willRetry: false })

  assert.equal(fakeSession.abortCount, 1)
  assert.deepEqual(await promptPromise, { stopReason: 'cancelled' })
})
