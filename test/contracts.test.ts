import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'
import { commands, extensions, Uri, workspace } from 'coc.nvim'
import type { ExtensionAPI } from '../src/extension.api.ts'

const SERVER_TIMEOUT = 10_000

interface RecordedMessage {
  method: string
  params: any
}

interface VirtualServerState {
  connected: boolean
  initializeParams?: any
  requests: RecordedMessage[]
  notifications: RecordedMessage[]
}

interface TestExtensionAPI extends ExtensionAPI {
  $testServer: {
    getState(): VirtualServerState
    waitForRequest(method: string, timeout?: number): Promise<RecordedMessage>
  }
}

interface ConfigurationSchema {
  type?: string | string[]
  enum?: unknown[]
  anyOf?: unknown[]
  default?: unknown
}

let api: TestExtensionAPI
let packageJson: any

function plain<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value))
}

function hasNestedValue(value: unknown, path: string[]): boolean {
  let current = value
  for (const part of path) {
    if (current === null || typeof current !== 'object'
      || !Object.prototype.hasOwnProperty.call(current, part)) {
      return false
    }
    current = (current as Record<string, unknown>)[part]
  }
  return true
}

async function withTimeout<T>(promise: Promise<T>, timeout: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeout)
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    clearTimeout(timer)
  }
}

async function waitForNotification(method: string, timeout = 5_000): Promise<RecordedMessage> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeout) {
    const notification = api.$testServer.getState().notifications.find(item => item.method === method)
    if (notification) return notification
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for virtual server notification ${method}`)
}

before(async () => {
  assert.equal(process.env.COC_JAVA_TEST_SERVER, 'virtual')
  const extension = extensions.getExtensionById<TestExtensionAPI>('coc-java')
  assert.ok(extension, 'coc-java should be loaded')
  assert.equal(extension.isActive, true, 'coc-java should be activated by coc-test')

  api = extension.exports
  packageJson = extension.packageJSON
  await withTimeout(api.serverReady(), SERVER_TIMEOUT, 'virtual Java server did not become ready')
})

describe('coc-java fast contracts', () => {
  it('loads every contributed Java setting and forwards it during initialization', () => {
    const properties = packageJson.contributes.configuration.properties as Record<string, ConfigurationSchema>
    const entries = Object.entries(properties)
    assert.equal(entries.length, 114, 'update this contract when settings are intentionally added or removed')

    const javaSettings = api.$testServer.getState().initializeParams?.initializationOptions?.settings?.java
    assert.ok(javaSettings, 'the virtual server should capture Java initialization settings')

    for (const [key, schema] of entries) {
      assert.match(key, /^java\./)
      assert.equal(Object.prototype.hasOwnProperty.call(schema, 'default'), true, `${key} should declare a default`)
      assert.ok(schema.type !== undefined || schema.enum !== undefined || schema.anyOf !== undefined,
        `${key} should declare a value shape`)

      const inspected = workspace.getConfiguration().inspect(key)
      assert.ok(inspected, `${key} should be registered with coc.nvim`)
      assert.deepEqual(plain(inspected.defaultValue), plain(schema.default), `${key} should expose its manifest default`)

      if (schema.enum) {
        assert.ok(schema.enum.some(value => JSON.stringify(value) === JSON.stringify(schema.default)),
          `${key} default should be one of its enum values`)
      }

      const relativePath = key.slice('java.'.length).split('.')
      const clientOnlyUndefined = key === 'java.project.outputPath' || key === 'java.project.sourcePaths'
      assert.ok(clientOnlyUndefined || hasNestedValue(javaSettings, relativePath),
        `${key} should be forwarded to the language server`)
    }
  })

  it('registers every contributed command plus the protocol bridge commands', () => {
    const contributed = packageJson.contributes.commands as Array<{ command: string }>
    assert.equal(contributed.length, 27, 'update this contract when public commands are intentionally changed')
    for (const { command } of contributed) {
      assert.equal(commands.has(command), true, `${command} should be registered`)
    }

    for (const command of [
      'java.execute.workspaceCommand',
      'java.open.output',
      'java.open.file',
      'java.runtimeValidation.open',
      'java.apply.workspaceEdit',
      '_java.workspace.path',
      '_java.reloadBundles.command',
      '_java.projectConfiguration.saveAndUpdate',
    ]) {
      assert.equal(commands.has(command), true, `${command} should be registered`)
    }
  })

  it('routes API and command requests through the virtual server', async () => {
    const uri = 'file:///virtual/Greeter.java'
    const symbols = await api.getDocumentSymbols({ textDocument: { uri } })
    assert.equal(symbols?.[0]?.name, 'Greeter')

    const definitions = await api.goToDefinition({
      textDocument: { uri },
      position: { line: 1, character: 5 },
    })
    assert.equal(Array.isArray(definitions), true)
    assert.equal((definitions as any[])[0].uri, uri)

    assert.deepEqual(plain(await api.getProjectSettings(uri, ['java.version'])), {})
    assert.deepEqual(plain(await api.getClasspaths(uri, { scope: 'test' })), {
      projectRoot: '',
      classpaths: [],
      modulepaths: [],
    })
    assert.equal(await api.isTestFile(uri), false)
    assert.deepEqual(plain(await commands.executeCommand('java.execute.workspaceCommand', 'java.project.getAll')), [])

    const commandUri = Uri.parse('file:///virtual/src')
    await commands.executeCommand('java.project.import.command')
    await commands.executeCommand('java.project.addToSourcePath.command', commandUri)
    await commands.executeCommand('java.project.removeFromSourcePath.command', commandUri)
    await commands.executeCommand('java.server.mode.switch', 'Standard', true)

    const requests = api.$testServer.getState().requests
    assert.ok(requests.some(request => request.method === 'textDocument/documentSymbol'))
    assert.ok(requests.some(request => request.method === 'textDocument/definition'))
    for (const command of [
      'java.project.getSettings',
      'java.project.getClasspaths',
      'java.project.isTestFile',
      'java.project.getAll',
      'java.project.import',
      'java.project.addToSourcePath',
      'java.project.removeFromSourcePath',
    ]) {
      assert.ok(requests.some(request => request.method === 'workspace/executeCommand'
        && request.params?.command === command), `${command} should reach the virtual server`)
    }

    await commands.executeCommand('java.projectConfiguration.update', Uri.parse(uri))
    const notification = await waitForNotification('java/projectConfigurationUpdate')
    assert.deepEqual(plain(notification.params), { uri })
  })
})
