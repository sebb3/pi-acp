import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

class FakeStore {
  readonly upserts: any[] = []

  constructor(private readonly entry: any | null) {}

  get(sessionId: string) {
    if (!this.entry || this.entry.sessionId !== sessionId) return null
    return this.entry
  }

  upsert(entry: any) {
    this.upserts.push(entry)
  }

  delete(_sessionId: string) {
    // noop
  }
}

function installSpawn(procFactory: (params: any) => any) {
  const originalSpawn = PiRpcProcess.spawn
  const calls: any[] = []

  ;(PiRpcProcess as any).spawn = async (params: any) => {
    calls.push(params)
    return procFactory(params)
  }

  return {
    calls,
    restore() {
      PiRpcProcess.spawn = originalSpawn
    }
  }
}

test('PiAcpAgent: prompt lazily revives a store-known session and continues the prompt', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-revive-store-'))
  const sessionFile = join(cwd, 'session.jsonl')
  const proc = new FakePiRpcProcess() as any

  proc.prompt = async (message: string, attachments: unknown[] = []) => {
    proc.prompts.push({ message, attachments })
    queueMicrotask(() => {
      proc.emit({ type: 'agent_start' })
      proc.emit({ type: 'agent_end' })
    })
  }

  const spawn = installSpawn(() => proc)

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore({
      sessionId: 's-store',
      cwd,
      sessionFile,
      updatedAt: '2026-01-01T00:00:00.000Z'
    })

    const res = await agent.prompt({
      sessionId: 's-store',
      prompt: [{ type: 'text', text: 'hello after revive' }]
    } as any)

    assert.equal(res.stopReason, 'end_turn')
    assert.equal(spawn.calls.length, 1)
    assert.equal(spawn.calls[0]?.cwd, cwd)
    assert.equal(spawn.calls[0]?.sessionPath, sessionFile)
    assert.equal(proc.prompts[0]?.message, 'hello after revive')
  } finally {
    spawn.restore()
  }
})

test('PiAcpAgent: cancel lazily revives a session found in pi session logs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-revive-logs-'))
  const project = mkdtempSync(join(tmpdir(), 'pi-acp-revive-project-'))
  const sessionsDir = join(root, 'sessions', '--project--')
  const sessionFile = join(sessionsDir, 's-log.jsonl')
  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(
    sessionFile,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 's-log',
      timestamp: '2026-01-01T00:00:00.000Z',
      cwd: project
    }) + '\n',
    'utf8'
  )

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  const proc = new FakePiRpcProcess() as any
  const spawn = installSpawn(() => proc)

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore(null)

    await agent.cancel({ sessionId: 's-log' } as any)

    assert.equal(spawn.calls.length, 1)
    assert.equal(spawn.calls[0]?.cwd, project)
    assert.equal(spawn.calls[0]?.sessionPath, sessionFile)
    assert.equal(proc.abortCount, 1)
  } finally {
    spawn.restore()
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})

test('PiAcpAgent: mode and model operations lazily revive missing sessions', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-revive-config-'))
  const sessionFile = join(cwd, 'session.jsonl')
  const proc = new FakePiRpcProcess() as any
  const thinkingLevels: string[] = []
  const models: Array<{ provider: string; modelId: string }> = []

  proc.setThinkingLevel = async (level: string) => {
    thinkingLevels.push(level)
  }
  proc.setModel = async (provider: string, modelId: string) => {
    models.push({ provider, modelId })
  }
  proc.getAvailableModels = async () => ({ models: [{ provider: 'test', id: 'model', name: 'model' }] })

  const spawn = installSpawn(() => proc)

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore({
      sessionId: 's-config',
      cwd,
      sessionFile,
      updatedAt: '2026-01-01T00:00:00.000Z'
    })

    await agent.setSessionMode({ sessionId: 's-config', modeId: 'high' } as any)
    await agent.unstable_setSessionModel({ sessionId: 's-config', modelId: 'model' })

    assert.equal(spawn.calls.length, 1)
    assert.deepEqual(thinkingLevels, ['high'])
    assert.deepEqual(models, [{ provider: 'test', modelId: 'model' }])
  } finally {
    spawn.restore()
  }
})

test('PiAcpAgent: newSession no longer closes other live sessions', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  let closeAllExceptCalled = false

  const session = {
    sessionId: 'new-session',
    cwd: process.cwd(),
    proc: {
      async getState() {
        return { thinkingLevel: 'medium', model: { provider: 'test', id: 'model' } }
      },
      async getAvailableModels() {
        return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
      }
    },
    setStartupInfo(_text: string) {
      // noop
    },
    sendStartupInfoIfPending() {
      // noop
    }
  }

  ;(agent as any).sessions = {
    async create() {
      return session
    },
    closeAllExcept() {
      closeAllExceptCalled = true
    }
  }

  await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)

  assert.equal(closeAllExceptCalled, false)
})

test('PiAcpAgent: loadSession reuses an in-memory session without closing or respawning', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  let closeCalled = false
  let closeAllExceptCalled = false
  let getMessagesCalled = false

  const session = {
    sessionId: 's-live',
    cwd: process.cwd(),
    proc: {
      async getMessages() {
        getMessagesCalled = true
        return { messages: [] }
      },
      async getState() {
        return { thinkingLevel: 'medium', model: { provider: 'test', id: 'model' } }
      },
      async getAvailableModels() {
        return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
      }
    }
  }

  const spawn = installSpawn(() => {
    throw new Error('should not spawn')
  })

  try {
    ;(agent as any).sessions = {
      maybeGet(sessionId: string) {
        return sessionId === 's-live' ? session : null
      },
      close() {
        closeCalled = true
      },
      closeAllExcept() {
        closeAllExceptCalled = true
      }
    }

    await agent.loadSession({ sessionId: 's-live', cwd: process.cwd(), mcpServers: [] } as any)

    assert.equal(getMessagesCalled, true)
    assert.equal(spawn.calls.length, 0)
    assert.equal(closeCalled, false)
    assert.equal(closeAllExceptCalled, false)
  } finally {
    spawn.restore()
  }
})
