import test from 'node:test'
import assert from 'node:assert/strict'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  constructor(private readonly session: any) {}
  async create(_params: any) {
    return this.session
  }
}

function fakeProc() {
  const state = {
    thinkingLevel: 'medium',
    model: { provider: 'test', id: 'model' }
  }

  return {
    setModels: [] as Array<{ provider: string; modelId: string }>,
    thinkingLevels: [] as string[],
    async getAvailableModels() {
      return { models: [{ provider: 'test', id: 'model', name: 'Model' }] }
    },
    async getState() {
      return state
    },
    async setModel(provider: string, modelId: string) {
      this.setModels.push({ provider, modelId })
      state.model = { provider, id: modelId }
    },
    async setThinkingLevel(level: string) {
      this.thinkingLevels.push(level)
      state.thinkingLevel = level
    }
  }
}

test('PiAcpAgent: newSession advertises model and thinking config options', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = fakeProc()
  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc,
    setStartupInfo() {},
    sendStartupInfoIfPending() {}
  }

  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  const res = await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)

  assert.deepEqual(
    res.configOptions?.map((option: any) => ({
      id: option.id,
      type: option.type,
      currentValue: option.currentValue,
      category: option.category
    })),
    [
      { id: 'model', type: 'select', currentValue: 'test/model', category: 'model' },
      { id: 'thinking', type: 'select', currentValue: 'medium', category: 'thought_level' }
    ]
  )
})

test('PiAcpAgent: setSessionConfigOption maps model and thinking selectors to pi', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = fakeProc()
  const session = { sessionId: 's1', cwd: process.cwd(), proc }
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).getOrReviveSession = async () => session

  const modelResponse = await agent.setSessionConfigOption({
    sessionId: 's1',
    configId: 'model',
    value: 'test/model'
  } as any)
  assert.deepEqual(proc.setModels, [{ provider: 'test', modelId: 'model' }])
  assert.equal(modelResponse.configOptions[0]!.currentValue, 'test/model')

  const thinkingResponse = await agent.setSessionConfigOption({
    sessionId: 's1',
    configId: 'thinking',
    value: 'high'
  } as any)
  assert.deepEqual(proc.thinkingLevels, ['high'])
  assert.equal(thinkingResponse.configOptions[1]!.currentValue, 'high')
  assert.equal(
    conn.updates.some(update => (update as any).update?.sessionUpdate === 'config_option_update'),
    true
  )
})
