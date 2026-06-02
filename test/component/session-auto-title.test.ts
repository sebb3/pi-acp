import test from 'node:test'
import assert from 'node:assert/strict'

import { PiAcpSession } from '../../src/acp/session.js'
import { PiRpcProcess, type PiRpcEvent } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

class FakeTitleProcess {
  readonly prompts: string[] = []
  readonly models: Array<{ provider: string; modelId: string }> = []
  disposed = false
  private handlers: Array<(ev: PiRpcEvent) => void> = []

  constructor(private readonly title: string) {}

  onEvent(handler: (ev: PiRpcEvent) => void): () => void {
    this.handlers.push(handler)
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler)
    }
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    this.models.push({ provider, modelId })
  }

  async prompt(message: string): Promise<void> {
    this.prompts.push(message)
    queueMicrotask(() => {
      for (const h of this.handlers) h({ type: 'agent_end' })
    })
  }

  async getLastAssistantText(): Promise<string> {
    return this.title
  }

  dispose(): void {
    this.disposed = true
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  assert.equal(predicate(), true)
}

async function completeTurn(session: PiAcpSession, proc: FakePiRpcProcess, message: string): Promise<void> {
  const prompt = session.prompt(message)
  proc.emit({ type: 'agent_end' })
  assert.equal(await prompt, 'end_turn')
}

test('PiAcpSession: auto-generates a sanitized title after the first completed turn only', async () => {
  const originalSpawn = PiRpcProcess.spawn
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.lastAssistantText = 'The assistant explained how to add OAuth login tests.'

  const titleProc = new FakeTitleProcess('"Add OAuth Login Tests"\nExtra text')
  const spawnParams: unknown[] = []
  ;(PiRpcProcess as any).spawn = async (params: unknown) => {
    spawnParams.push(params)
    return titleProc
  }

  try {
    const session = new PiAcpSession({
      sessionId: 's1',
      cwd: process.cwd(),
      mcpServers: [],
      proc: proc as any,
      conn: asAgentConn(conn),
      fileCommands: [],
      piCommand: 'custom-pi'
    })

    await completeTurn(session, proc, 'How do we test OAuth login?')

    await waitUntil(() => proc.sessionNames.length === 1)

    assert.deepEqual(spawnParams, [{ cwd: process.cwd(), piCommand: 'custom-pi', noSession: true }])
    assert.deepEqual(titleProc.models, [{ provider: 'openai-codex', modelId: 'gpt-5.4-mini' }])
    assert.equal(titleProc.disposed, true)
    assert.equal(proc.sessionNames[0], 'Add OAuth Login Tests')
    assert.equal(titleProc.prompts[0]!.includes('How do we test OAuth login?'), true)
    assert.equal(titleProc.prompts[0]!.includes('The assistant explained how to add OAuth login tests.'), true)

    const titleUpdate = conn.updates.find(
      u => u.update.sessionUpdate === 'session_info_update' && (u.update as any).title
    )
    assert.equal((titleUpdate?.update as any).title, 'Add OAuth Login Tests')

    await completeTurn(session, proc, 'Second user message')
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(spawnParams.length, 1)
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpSession: re-checks sessionName before applying an auto-generated title', async () => {
  const originalSpawn = PiRpcProcess.spawn
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.lastAssistantText = 'Assistant response.'
  proc.state = { sessionName: 'Manual Name' }

  let spawnCount = 0
  ;(PiRpcProcess as any).spawn = async () => {
    spawnCount += 1
    return new FakeTitleProcess('Generated Name')
  }

  try {
    const session = new PiAcpSession({
      sessionId: 's1',
      cwd: process.cwd(),
      mcpServers: [],
      proc: proc as any,
      conn: asAgentConn(conn),
      fileCommands: []
    })

    await completeTurn(session, proc, 'First user message')
    await new Promise(resolve => setTimeout(resolve, 0))

    assert.equal(spawnCount, 0)
    assert.deepEqual(proc.sessionNames, [])
    assert.equal(
      conn.updates.some(u => u.update.sessionUpdate === 'session_info_update' && (u.update as any).title),
      false
    )
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})
