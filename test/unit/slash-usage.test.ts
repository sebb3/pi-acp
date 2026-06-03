import test from 'node:test'
import assert from 'node:assert/strict'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

test('PiAcpAgent: /usage reports context window remaining as agent text', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).getOrReviveSession = async () => ({
    sessionId: 's1',
    proc: {
      async getSessionStats() {
        return {
          totalMessages: 12,
          cost: 0.1234,
          contextUsage: { tokens: 1500, contextWindow: 200000, percent: 0.75 },
          tokens: { input: 1000, output: 400, cacheRead: 100, total: 1500 }
        }
      }
    }
  })

  const response = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/usage' }]
  } as any)

  assert.deepEqual(response, { stopReason: 'end_turn' })
  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: {
      type: 'text',
      text: [
        'Usage',
        'Context: 1,500 / 200,000 tokens',
        'Remaining: 198,500 tokens (99.3% free)',
        'Used: 0.8%',
        'Tokens: input 1,000, output 400, cache read 100, total 1,500',
        'Cost: $0.1234',
        'Messages: 12'
      ].join('\n')
    }
  })
})
