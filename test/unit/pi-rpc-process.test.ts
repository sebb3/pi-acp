import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiRpcProcess } from '../../src/pi-rpc/process.js'

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(predicate(), true)
}

test('PiRpcProcess.spawn: supports --no-session and get_last_assistant_text', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-rpc-'))
  const argvPath = join(root, 'argv.json')
  const commandsPath = join(root, 'commands.jsonl')
  const scriptPath = join(root, 'fake-pi.cjs')

  writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const fs = require('node:fs')
fs.writeFileSync(process.env.PI_ACP_TEST_ARGV, JSON.stringify(process.argv.slice(2)))
let buffered = ''
process.stdin.resume()
process.stdin.on('data', chunk => {
  buffered += chunk.toString('utf8')
  const lines = buffered.split(/\\n/)
  buffered = lines.pop() || ''
  for (const line of lines) {
    if (!line.trim()) continue
    const msg = JSON.parse(line)
    fs.appendFileSync(process.env.PI_ACP_TEST_COMMANDS, JSON.stringify({ type: msg.type }) + '\\n')
    const data = msg.type === 'get_last_assistant_text' ? { text: 'Last assistant answer' } : {}
    process.stdout.write(JSON.stringify({ type: 'response', id: msg.id, command: msg.type, success: true, data }) + '\\n')
  }
})
`,
    'utf8'
  )
  chmodSync(scriptPath, 0o755)

  const oldArgv = process.env.PI_ACP_TEST_ARGV
  const oldCommands = process.env.PI_ACP_TEST_COMMANDS
  process.env.PI_ACP_TEST_ARGV = argvPath
  process.env.PI_ACP_TEST_COMMANDS = commandsPath

  let proc: PiRpcProcess | null = null
  try {
    proc = await PiRpcProcess.spawn({ cwd: root, piCommand: scriptPath, noSession: true })
    await waitUntil(() => existsSync(argvPath) && readFileSync(argvPath, 'utf8').length > 0)

    const argv = JSON.parse(readFileSync(argvPath, 'utf8')) as string[]
    assert.deepEqual(argv, ['--mode', 'rpc', '--no-themes', '--no-session'])

    const text = await proc.getLastAssistantText()
    assert.equal(text, 'Last assistant answer')

    const commands = readFileSync(commandsPath, 'utf8')
      .trim()
      .split(/\n/)
      .map(line => JSON.parse(line).type)
    assert.deepEqual(commands, ['get_last_assistant_text'])
  } finally {
    proc?.dispose()
    if (oldArgv === undefined) delete process.env.PI_ACP_TEST_ARGV
    else process.env.PI_ACP_TEST_ARGV = oldArgv
    if (oldCommands === undefined) delete process.env.PI_ACP_TEST_COMMANDS
    else process.env.PI_ACP_TEST_COMMANDS = oldCommands
  }
})
