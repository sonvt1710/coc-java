import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { commands, ConfigurationTarget, Uri, workspace } from 'coc.nvim'
import packageJson from '../package.json'
import { apiManager } from '../src/apiManager.ts'
import type { ExtensionAPI } from '../src/extension.api.ts'
import { getJavaEncoding, getJavaServerMode, ServerMode } from '../src/settings.ts'
import { getBuildFilePatterns, getJavaConfig } from '../src/utils.ts'
import { createTypeBodySnippet } from '../src/fileEventHandler.ts'
import { addAppCDSParams, addJavacParams, getPredefinedVariablesEnv, getUnicodeLocaleEnv, prepareParams } from '../src/javaServerStarter.ts'
import { sanitizeCommandLinksInHover } from '../src/hoverAction.ts'
import { isCompatibleLombokVersion, parseLombokVersion, parseLombokVersionNumber } from '../src/lombokSupport.ts'
import { isCompatibleRuntime } from '../src/javaRuntimes.ts'
import { requestMoveWithConfirmation } from '../src/refactorAction.ts'

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

interface VirtualServer {
  getState(): VirtualServerState
  setBuildStatus(status: number): void
  waitForRequest(method: string, timeout?: number, after?: number): Promise<RecordedMessage>
  waitForNotification(method: string, timeout?: number, after?: number, expectedParams?: unknown): Promise<RecordedMessage>
}

declare global {
  var __coc_java_test_server__: VirtualServer | undefined
}

interface ConfigurationSchema {
  type?: string | string[]
  enum?: unknown[]
  anyOf?: unknown[]
  default?: unknown
}

let api: ExtensionAPI
let virtualServer: VirtualServer
let fixtureDirectory: string
let javaDocumentUri: string

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

async function executeAndWaitForRequest<T>(method: string, execute: () => Promise<T>): Promise<[T, RecordedMessage]> {
  const after = virtualServer.getState().requests.length
  const pending = virtualServer.waitForRequest(method, 5_000, after)
  const result = await execute()
  return [result, await pending]
}

async function executeAndWaitForNotification<T>(
  method: string,
  execute: () => Promise<T>,
  expectedParams?: unknown,
): Promise<[T, RecordedMessage]> {
  const after = virtualServer.getState().notifications.length
  const pending = virtualServer.waitForNotification(method, 5_000, after, expectedParams)
  const result = await execute()
  return [result, await pending]
}

before(async () => {
  assert.equal(process.env.COC_JAVA_TEST_SERVER, 'virtual')
  virtualServer = globalThis.__coc_java_test_server__
  assert.ok(virtualServer, 'coc-test setup should start the virtual Java server')

  api = apiManager.getApiInstance()
  await withTimeout(api.serverReady(), SERVER_TIMEOUT, 'virtual Java server did not become ready')

  fixtureDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'coc-java-contracts-'))
  const javaFile = path.join(fixtureDirectory, 'Greeter.java')
  await fs.writeFile(javaFile, 'public class Greeter {}\n')
  const document = await workspace.openTextDocument(Uri.file(javaFile))
  await workspace.jumpTo(document.uri)
  await workspace.nvim.command('setfiletype java')
  javaDocumentUri = document.uri
})

after(async () => {
  if (fixtureDirectory) {
    await fs.rm(fixtureDirectory, { recursive: true, force: true })
  }
})

describe('coc-java fast contracts', () => {
  it('loads every contributed Java setting and forwards it during initialization', () => {
    const properties = packageJson.contributes.configuration.properties as Record<string, ConfigurationSchema>
    const entries = Object.entries(properties)
    assert.equal(entries.length, 133, 'update this contract when settings are intentionally added or removed')

    const javaSettings = virtualServer.getState().initializeParams?.initializationOptions?.settings?.java
    assert.ok(javaSettings, 'the virtual server should capture Java initialization settings')
    assert.equal(javaSettings.jdt.ls.kotlinSupport.enabled, true)
    assert.equal(javaSettings.inlayHints.formatParameters.enabled, false)
    assert.equal(javaSettings.search.scope, 'all')
    assert.equal(
      virtualServer.getState().initializeParams?.initializationOptions?.extendedClientCapabilities?.moveRefactoringConfirmationSupport,
      true,
    )

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

  it('normalizes the main server settings and honors importer toggles', async () => {
    const javaConfig = getJavaConfig('/virtual/jdk')
    assert.equal(javaConfig.home, '/virtual/jdk')
    assert.equal(javaConfig.jdt.ls.androidSupport.enabled, false)
    assert.equal(javaConfig.jdt.ls.javac.enabled, false)
    assert.equal(javaConfig.completion.matchCase, 'off')
    assert.equal(javaConfig.implementationCodeLens, 'none')
    assert.equal(javaConfig.project.outputPath, undefined)
    assert.equal(javaConfig.project.sourcePaths, undefined)
    assert.equal(getJavaServerMode(), ServerMode.standard)
    assert.equal(typeof getJavaEncoding(), 'string')
    assert.deepEqual(plain(getBuildFilePatterns()), [])

    const configuration = workspace.getConfiguration()
    try {
      await configuration.update('java.import.maven.enabled', true, ConfigurationTarget.Global)
      await configuration.update('java.import.gradle.enabled', true, ConfigurationTarget.Global)
      assert.deepEqual(plain(getBuildFilePatterns()), ['**/pom.xml', '**/*.gradle', '**/*.gradle.kts'])
    } finally {
      await configuration.update('java.import.maven.enabled', undefined, ConfigurationTarget.Global)
      await configuration.update('java.import.gradle.enabled', undefined, ConfigurationTarget.Global)
    }
  })

  it('forwards live setting changes to the virtual server', async () => {
    const configuration = workspace.getConfiguration()
    try {
      const expected = { settings: { java: { completion: { maxResults: 50 } } } }
      const [, notification] = await executeAndWaitForNotification(
        'workspace/didChangeConfiguration',
        () => configuration.update('java.completion.maxResults', 50, ConfigurationTarget.Global),
        expected,
      )
      assert.equal(notification.params?.settings?.java?.completion?.maxResults, 50)
    } finally {
      await configuration.update('java.completion.maxResults', undefined, ConfigurationTarget.Global)
    }
  })

  it('registers every contributed command plus the protocol bridge commands', () => {
    const contributed = packageJson.contributes.commands as Array<{ command: string }>
    assert.equal(contributed.length, 30, 'update this contract when public commands are intentionally changed')
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
    assert.equal(commands.has('java.runtimes.add'), true)
  })

  it('matches detected JDKs to supported execution environments', () => {
    assert.equal(isCompatibleRuntime({ homedir: '/jdk-8', version: { java_version: '1.8.0', major: 8 } }, 'JavaSE-1.8'), true)
    assert.equal(isCompatibleRuntime({ homedir: '/jdk-8', version: { java_version: '1.8.0', major: 8 } }, 'JavaSE-9'), false)
    assert.equal(isCompatibleRuntime({ homedir: '/jdk-17', version: { java_version: '17.0.0', major: 17 } }, 'JavaSE-17'), true)
    assert.equal(isCompatibleRuntime({ homedir: '/jdk-17', version: { java_version: '17.0.0', major: 17 } }, 'JavaSE-21'), false)
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
    assert.equal(typeof api.serverRunning, 'function')
    assert.equal(await api.serverRunning?.(), true)
    assert.deepEqual(plain(await commands.executeCommand('java.execute.workspaceCommand', 'java.project.getAll')), [])

    const commandUri = Uri.parse('file:///virtual/src')
    await commands.executeCommand('java.project.import.command')
    await commands.executeCommand('java.project.addToSourcePath.command', commandUri)
    await commands.executeCommand('java.project.removeFromSourcePath.command', commandUri)
    await commands.executeCommand('java.project.listSourcePaths.command')
    await commands.executeCommand('java.server.mode.switch', 'Standard', true)

    const requests = virtualServer.getState().requests
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
      'java.project.listSourcePaths',
    ]) {
      assert.ok(requests.some(request => request.method === 'workspace/executeCommand'
        && request.params?.command === command), `${command} should reach the virtual server`)
    }

    const [, notification] = await executeAndWaitForNotification('java/projectConfigurationUpdate', () => {
      return commands.executeCommand('java.projectConfiguration.update', Uri.parse(uri))
    })
    assert.deepEqual(plain(notification.params), { uri })
  })

  it('routes compile, project build, cleanup, and navigation requests', async () => {
    const [compileResult, compileRequest] = await executeAndWaitForRequest('java/buildWorkspace', () => {
      return commands.executeCommand<number>('java.workspace.compile', false)
    })
    assert.equal(compileResult, 1)
    assert.equal(compileRequest.params, false)

    const projectUri = Uri.parse('file:///virtual/project')
    const [buildResult, buildRequest] = await executeAndWaitForRequest('java/buildProjects', () => {
      return commands.executeCommand('java.project.build', projectUri)
    })
    assert.equal(buildResult, 1)
    assert.deepEqual(plain(buildRequest.params), {
      identifiers: [{ uri: projectUri.toString() }],
      isFullBuild: false,
    })

    virtualServer.setBuildStatus(2)
    try {
      const [withErrors] = await executeAndWaitForRequest('java/buildWorkspace', () => {
        return commands.executeCommand<number>('java.workspace.compile', false)
      })
      assert.equal(withErrors, 2, 'language-server build statuses should resolve instead of reject')
    } finally {
      virtualServer.setBuildStatus(1)
    }

    const [, cleanupRequest] = await executeAndWaitForRequest('java/cleanup', () => {
      return commands.executeCommand('java.action.doCleanup')
    })
    assert.equal(cleanupRequest.params?.uri, javaDocumentUri)

    const [, navigationRequest] = await executeAndWaitForRequest('java/findLinks', () => {
      return commands.executeCommand('java.action.navigateToSuperImplementation', Uri.parse(javaDocumentUri))
    })
    assert.equal(navigationRequest.params?.type, 'superImplementation')
    assert.equal(navigationRequest.params?.position?.textDocument?.uri, javaDocumentUri)
  })

  it('copies a fully qualified name through the workspace command bridge', async () => {
    const [, request] = await executeAndWaitForRequest('workspace/executeCommand', () => {
      return commands.executeCommand('java.action.copyFullyQualifiedName')
    })
    assert.equal(request.params?.command, 'java.getFullyQualifiedName')
    const params = JSON.parse(request.params?.arguments?.[0])
    assert.equal(params.textDocument.uri, javaDocumentUri)
    assert.equal(await workspace.nvim.call('getreg', ['+']), 'com.example.Greeter')
  })

  it('adapts portable upstream startup and template behavior', async () => {
    assert.deepEqual(plain(getUnicodeLocaleEnv('win32', { LANG: 'C' })), {})
    assert.deepEqual(plain(getUnicodeLocaleEnv('linux', {})), { LC_CTYPE: 'C.UTF-8' })
    assert.deepEqual(plain(getUnicodeLocaleEnv('linux', { LC_ALL: 'POSIX' })), { LC_ALL: 'C.UTF-8' })
    assert.deepEqual(plain(getUnicodeLocaleEnv('linux', { LANG: 'en_US.UTF-8' })), {})
    assert.deepEqual(plain(getUnicodeLocaleEnv('linux', { LANG: 'zh_CN.GBK' })), {})

    const variables = getPredefinedVariablesEnv()
    assert.ok(variables.userHome)
    assert.equal(typeof variables.workspaceFolder, 'string')
    assert.equal(typeof variables.workspaceFolderBasename, 'string')

    assert.deepEqual(plain(createTypeBodySnippet('public class Greeter', '  ', 'end_of_line')), [
      'public class Greeter {', '  ${0}', '}',
    ])
    assert.deepEqual(plain(createTypeBodySnippet('class Greeter', '\t', 'next_line')), [
      'class Greeter', '{', '\t${0}', '}',
    ])
    assert.deepEqual(plain(createTypeBodySnippet('class Greeter', '  ', 'next_line_shifted')), [
      'class Greeter', '  {', '    ${0}', '  }',
    ])

    const sanitized = sanitizeCommandLinksInHover({
      contents: [{ language: 'markdown', value: '[unsafe](command:evil.run) and [JDK](jdt://contents/java.base)' }],
    })
    assert.equal((sanitized.contents[0] as any).value, 'unsafe and [JDK](jdt://contents/java.base)')

    const state = { get: () => undefined, update: async () => undefined }
    const context = {
      extensionPath: path.resolve(process.cwd()),
      storagePath: path.join(fixtureDirectory, 'storage'),
      globalState: state,
      workspaceState: state,
      asAbsolutePath: (relativePath: string) => path.resolve(process.cwd(), relativePath),
    } as any
    const params = prepareParams({
      tooling_jre: '/virtual/jdk',
      tooling_jre_version: 24,
      java_home: '/virtual/jdk',
      java_version: 24,
    }, path.join(fixtureDirectory, 'workspace'), context, false)
    assert.ok(params.includes('-Djdk.xml.maxGeneralEntitySizeLimit=0'))
    assert.ok(params.includes('-Djdk.xml.totalEntitySizeLimit=0'))

    const javacParams: string[] = []
    addJavacParams(javacParams, 'dom')
    for (const flag of [
      'jdk.compiler/com.sun.tools.javac.processing=ALL-UNNAMED',
      'jdk.compiler/com.sun.tools.javac.model=ALL-UNNAMED',
      '-DSourceIndexer.DOM_BASED_INDEXER=true',
      '-DMatchLocator.DOM_BASED_MATCH=true',
      '-DIJavaSearchDelegate=org.eclipse.jdt.internal.core.search.DOMJavaSearchDelegate',
      '-DCompilationUnit.codeComplete.DOM_BASED_OPERATIONS=true',
    ]) {
      assert.ok(javacParams.includes(flag), `${flag} should be forwarded to jdt-javac`)
    }

    const appCDSParams: string[] = []
    addAppCDSParams(appCDSParams, 'on', fixtureDirectory, '1.42.0', 21, '')
    assert.ok(appCDSParams.includes('-XX:+AutoCreateSharedArchive'))
    assert.ok(appCDSParams.some(param => param.startsWith('-XX:SharedArchiveFile=')))
    const debugParams = ['-agentlib:jdwp=transport=dt_socket']
    addAppCDSParams(debugParams, 'on', fixtureDirectory, '1.42.0', 21, '')
    assert.equal(debugParams.length, 1, 'AppCDS should stay disabled while debugging')
    const java17Params: string[] = []
    addAppCDSParams(java17Params, 'on', fixtureDirectory, '1.42.0', 17, '')
    assert.equal(java17Params.length, 0, 'AppCDS should stay disabled on the supported Java 17 fallback')
  })

  it('parses Lombok versions without crashing on malformed jar names', () => {
    assert.equal(parseLombokVersion(undefined), undefined)
    assert.equal(parseLombokVersion('/tmp/example.jar'), undefined)
    assert.equal(parseLombokVersionNumber('/tmp/lombok.jar'), undefined)
    assert.equal(isCompatibleLombokVersion(undefined), false)
    assert.equal(isCompatibleLombokVersion('not-a-version'), false)

    const jar = '/tmp/lombok-1.18.32.jar'
    assert.equal(parseLombokVersion(jar), 'lombok-1.18.32')
    assert.equal(parseLombokVersionNumber(jar), '1.18.32')
    assert.equal(isCompatibleLombokVersion('1.18.0'), true)
    assert.equal(isCompatibleLombokVersion('1.17.0'), false)
  })

  it('retries move refactoring only after confirmation', async () => {
    const requests: any[] = []
    const client = {
      sendRequest: async (_type: unknown, params: any) => {
        requests.push(plain(params))
        return requests.length === 1
          ? { confirmationToken: 'confirm-move', errorMessage: 'A target method may be shadowed.' }
          : { edit: { changes: {} } }
      },
    } as any
    const moveParams = {
      moveKind: 'moveInstanceMethod',
      sourceUris: [javaDocumentUri],
      params: {
        textDocument: { uri: javaDocumentUri },
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        context: { diagnostics: [] },
      },
      destination: { name: 'target' },
    }
    let confirmationMessage = ''
    await requestMoveWithConfirmation(client, moveParams, async message => {
      confirmationMessage = message
      return true
    })
    assert.match(confirmationMessage, /target method may be shadowed/)
    assert.equal(requests.length, 2)
    assert.equal(requests[1].confirmationToken, 'confirm-move')

    requests.length = 0
    await requestMoveWithConfirmation(client, moveParams, async () => false)
    assert.equal(requests.length, 1)
  })

  it('uses project and hierarchy protocol commands for command-palette actions', async () => {
    const [, projectRequest] = await executeAndWaitForRequest('workspace/executeCommand', () => {
      return commands.executeCommand('java.project.createModuleInfo.command')
    })
    assert.equal(projectRequest.params?.command, 'java.project.getAll')

    const after = virtualServer.getState().requests.length
    const hierarchyRequest = virtualServer.waitForRequest('workspace/executeCommand', 5_000, after)
    await commands.executeCommand('java.action.showTypeHierarchy', Uri.parse(javaDocumentUri))
    const request = await hierarchyRequest
    assert.equal(request.params?.command, 'java.navigate.openTypeHierarchy')
  })

  it('sends one notification for every selected project', async () => {
    const uris = [Uri.parse('file:///virtual/one'), Uri.parse('file:///virtual/two')]
    const [, notification] = await executeAndWaitForNotification('java/projectConfigurationsUpdate', () => {
      return commands.executeCommand('java.projectConfiguration.update', uris)
    })
    assert.deepEqual(plain(notification.params), {
      identifiers: uris.map(uri => ({ uri: uri.toString() })),
    })
  })
})
