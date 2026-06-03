import test from 'node:test'
import assert from 'node:assert/strict'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  createParams: any = null
  constructor(private readonly session: any) {}
  async create(params: any) {
    this.createParams = params
    return this.session
  }
}

function fakeSession() {
  return {
    sessionId: 's1',
    cwd: '/workspace/a',
    proc: {
      async getState() {
        return { model: { provider: 'test', id: 'model' }, thinkingLevel: 'medium' }
      },
      async getAvailableModels() {
        return { models: [{ provider: 'test', id: 'model', name: 'Model' }] }
      }
    },
    setStartupInfo() {},
    sendStartupInfoIfPending() {}
  }
}

test('PiAcpAgent: advertises additionalDirectories session capability', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()), {} as any)
  const response = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} } as any)

  assert.deepEqual(response.agentCapabilities?.sessionCapabilities?.additionalDirectories, {})
})

test('PiAcpAgent: newSession validates and passes additionalDirectories', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()), {} as any)
  const sessions = new FakeSessions(fakeSession())
  ;(agent as any).sessions = sessions

  await agent.newSession({
    cwd: '/workspace/a',
    additionalDirectories: ['/workspace/b', '/workspace/b', '/workspace/a'],
    mcpServers: []
  } as any)

  assert.deepEqual(sessions.createParams.additionalDirectories, ['/workspace/b'])
})

test('PiAcpAgent: rejects relative additionalDirectories', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()), {} as any)

  await assert.rejects(
    agent.newSession({ cwd: '/workspace/a', additionalDirectories: ['relative'], mcpServers: [] } as any)
  )
})
