import test from 'node:test'
import assert from 'node:assert/strict'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

test('PiAcpAgent: includes prompt response usage when session has latest usage', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()), {} as any)
  ;(agent as any).getOrReviveSession = async () => ({
    sessionId: 's1',
    async prompt() {
      return 'end_turn'
    },
    wasCancelRequested() {
      return false
    },
    getLastPromptUsage() {
      return {
        inputTokens: 100,
        outputTokens: 20,
        cachedReadTokens: 10,
        totalTokens: 130
      }
    }
  })

  const response = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: 'hello' }]
  } as any)

  assert.deepEqual(response, {
    stopReason: 'end_turn',
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      cachedReadTokens: 10,
      totalTokens: 130
    }
  })
})
