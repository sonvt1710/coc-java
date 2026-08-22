import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { commands, workspace, type Document } from 'coc.nvim'
import { apiManager } from '../src/apiManager.ts'
import type { ExtensionAPI } from '../src/extension.api.ts'
import { extendedOutlineTree } from '../src/outline/extendedOutlineTree.ts'

const SERVER_TIMEOUT = 180_000

let api: ExtensionAPI
let fixtureDirectory: string
let javaDocumentUri: string

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

async function waitForDocument(bufnr: number, timeout = 15_000): Promise<Document> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeout) {
    const document = workspace.getDocument(bufnr)
    if (document?.attached) return document
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('Java document did not attach in time')
}

async function waitForLanguageId(document: Document, timeout = 15_000): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeout) {
    if (document.languageId === 'java') return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Java document languageId remained ${JSON.stringify(document.languageId)}`)
}

before(async () => {
  api = apiManager.getApiInstance()
  await withTimeout(api.serverReady(), SERVER_TIMEOUT, 'Java language server did not become ready')

  fixtureDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'coc-java-test-'))
  const javaFile = path.join(fixtureDirectory, 'Greeter.java')
  await fs.writeFile(javaFile, [
    'public class Greeter {',
    '  public String greet(String name) {',
    '    return "Hello, " + name;',
    '  }',
    '',
    '  public String completeName() {',
    '    String name = "James";',
    '    return name;',
    '  }',
    '}',
    '',
  ].join('\n'))

  const escapedFile = await workspace.nvim.call('fnameescape', [javaFile]) as string
  await workspace.nvim.command(`edit ${escapedFile}`)
  const bufnr = await workspace.nvim.eval('bufnr("%")') as number
  const document = await waitForDocument(bufnr)
  await workspace.nvim.command('setfiletype java')
  await waitForLanguageId(document)
  javaDocumentUri = document.uri
  assert.equal(document.languageId, 'java')
})

after(async () => {
  if (fixtureDirectory) {
    await fs.rm(fixtureDirectory, { recursive: true, force: true })
  }
})

describe('coc-java integration', () => {
  it('exposes a started standard-mode API', () => {
    assert.equal(api.apiVersion, '0.10')
    assert.equal(api.serverMode, 'Standard')
    assert.equal(api.status, 'Started')
    assert.ok(api.javaRequirement.tooling_jre_version >= 17)
    assert.equal(typeof api.getDocumentSymbols, 'function')
    assert.equal(typeof api.goToDefinition, 'function')
    assert.equal(typeof api.serverRunning, 'function')
  })

  it('registers the primary user commands', () => {
    for (const command of [
      'java.projectConfiguration.update',
      'java.workspace.compile',
      'java.open.serverLog',
      'java.open.clientLog',
      'java.clean.workspace',
      'java.project.import.command',
      'java.action.doCleanup',
      'java.action.showExtendedOutline',
    ]) {
      assert.equal(commands.has(command), true, `${command} should be registered`)
    }
  })

  it('returns symbols for a real Java document', async () => {
    const symbols = await api.getDocumentSymbols({
      textDocument: { uri: javaDocumentUri },
    })

    assert.ok(symbols && symbols.length > 0, 'expected Java document symbols')
    const greeter = symbols.find(symbol => symbol.name === 'Greeter')
    assert.ok(greeter, 'expected the Greeter class symbol')
    assert.ok('children' in greeter)
    assert.ok(
      greeter.children?.some(symbol => symbol.name === 'greet' || symbol.name.startsWith('greet(')),
      'expected the greet method symbol',
    )
  })

  it('returns method completions after a member access', async () => {
    try {
      await workspace.nvim.call('cursor', [8, 16])
      await workspace.nvim.command('startinsert')
      await withTimeout((async () => {
        while (!String(await workspace.nvim.call('mode')).startsWith('i')) {
          await new Promise(resolve => setTimeout(resolve, 50))
        }
      })(), 5_000, 'editor did not enter insert mode')
      await workspace.nvim.call('coc#pum#close', ['cancel'])
      await workspace.nvim.input('.')
      await withTimeout((async () => {
        while (await workspace.nvim.call('getline', [8]) !== '    return name.;') {
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        while (await workspace.nvim.call('coc#pum#visible') !== 1) {
          await new Promise(resolve => setTimeout(resolve, 50))
        }
      })(), 15_000, 'completion menu did not become visible')

      const pumWinid = await workspace.nvim.call('coc#pum#winid') as number
      const words = await workspace.nvim.call('getwinvar', [pumWinid, 'words', []]) as string[]
      assert.ok(
        words.some(word => word.startsWith('length')),
        `expected String.length() in the completion menu, received ${JSON.stringify(words)}`,
      )
    } finally {
      await workspace.nvim.command('stopinsert')
      await workspace.nvim.command('silent! undo')
    }
  })

  it('renders an extended outline from the real Java language server', async () => {
    try {
      await withTimeout(
        commands.executeCommand('java.action.showExtendedOutline'),
        30_000,
        'extended outline request did not complete',
      )
      assert.equal(await workspace.nvim.eval('get(w:, "cocViewId", "")'), 'javaExtendedOutline')
      const lines = await workspace.nvim.call('getline', [1, '$']) as string[]
      assert.ok(lines.some(line => line.includes('Greeter')))
      assert.ok(lines.some(line => line.includes('greet')))
    } finally {
      await extendedOutlineTree.close()
    }
  })
})
