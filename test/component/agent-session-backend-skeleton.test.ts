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
