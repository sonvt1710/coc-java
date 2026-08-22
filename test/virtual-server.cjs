'use strict'

const net = require('node:net')
const {
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} = require('vscode-languageserver-protocol/node')

const BUILD_SUCCEEDED = 1

function range(line = 0, character = 0) {
  return {
    start: { line, character },
    end: { line, character: character + 1 },
  }
}

function emptyEdit() {
  return { changes: {} }
}

function containsSubset(value, expected) {
  if (expected === undefined) return true
  if (expected === null || typeof expected !== 'object') return Object.is(value, expected)
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(expected)) {
    return Array.isArray(value) && expected.length === value.length
      && expected.every((item, index) => containsSubset(value[index], item))
  }
  return Object.entries(expected).every(([key, item]) => containsSubset(value[key], item))
}

/**
 * A small JSON-RPC language server used by fast coc-test tests.
 *
 * It deliberately speaks through the same socket transport that
 * StandardLanguageClient uses for JDTLS_CLIENT_PORT.  This keeps the test on
 * the real extension/client path without starting a JVM or JDT LS.
 */
class VirtualLanguageServer {
  constructor(options = {}) {
    this.host = options.host || '127.0.0.1'
    this.server = undefined
    this.socket = undefined
    this.connection = undefined
    this.port = undefined
    this.started = false
    this.connected = false
    this.stopped = false
    this.initializeParams = undefined
    this.requests = []
    this.notifications = []
    this.buildStatus = BUILD_SUCCEEDED
    this.projectUris = []
    this.completionSelectionPending = false
    this._requestWaiters = []
    this._notificationWaiters = []
    this._statusTimer = undefined
    this._previousClientPort = undefined
    this._hadClientPort = false
  }

  async start() {
    if (this.started) return this

    this.stopped = false
    this.server = net.createServer(socket => this._accept(socket))
    await new Promise((resolve, reject) => {
      const onError = error => {
        this.server?.removeListener('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        this.server.removeListener('error', onError)
        resolve()
      }
      this.server.once('error', onError)
      this.server.once('listening', onListening)
      this.server.listen(0, this.host)
    })

    this.port = this.server.address().port
    this.server.unref()
    this._hadClientPort = Object.prototype.hasOwnProperty.call(process.env, 'JDTLS_CLIENT_PORT')
    this._previousClientPort = process.env.JDTLS_CLIENT_PORT
    process.env.JDTLS_CLIENT_PORT = String(this.port)
    this.started = true
    return this
  }

  async stop() {
    if (this.stopped) return
    this.stopped = true
    this.started = false
    this.connected = false
    if (this._statusTimer) {
      clearTimeout(this._statusTimer)
      this._statusTimer = undefined
    }

    const waiters = this._requestWaiters.splice(0)
    for (const waiter of waiters) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('Virtual language server stopped'))
    }
    const notificationWaiters = this._notificationWaiters.splice(0)
    for (const waiter of notificationWaiters) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('Virtual language server stopped'))
    }

    const connection = this.connection
    const socket = this.socket
    this.connection = undefined
    this.socket = undefined

    try {
      connection?.dispose?.()
    } catch (_error) {
      // The socket is closed below even when the JSON-RPC connection is gone.
    }
    if (socket && !socket.destroyed) {
      socket.end()
      socket.destroy()
    }

    const server = this.server
    this.server = undefined
    if (server && server.listening) {
      await new Promise(resolve => server.close(() => resolve()))
    }

    if (this._hadClientPort) {
      process.env.JDTLS_CLIENT_PORT = this._previousClientPort
    } else {
      delete process.env.JDTLS_CLIENT_PORT
    }
    this.port = undefined
  }

  /**
   * Wait for the next request with the given method. Existing requests are
   * returned first, which also makes this useful after initialization.
   */
  waitForRequest(method, timeout = 5000, after = 0) {
    const existing = this.requests.find((request, index) => index >= after
      && request.method === method && !request.claimed)
    if (existing) {
      existing.claimed = true
      return Promise.resolve(existing)
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        method,
        after,
        resolve: request => {
          request.claimed = true
          resolve(request)
        },
        reject,
        timer: setTimeout(() => {
          const index = this._requestWaiters.indexOf(waiter)
          if (index !== -1) this._requestWaiters.splice(index, 1)
          reject(new Error(`Timed out waiting for virtual server request ${method}`))
        }, timeout),
      }
      this._requestWaiters.push(waiter)
    })
  }

  /** Wait for a notification recorded at or after the given message index. */
  waitForNotification(method, timeout = 5000, after = 0, expectedParams) {
    const existing = this.notifications.find((notification, index) => index >= after
      && notification.method === method && !notification.claimed
      && containsSubset(notification.params, expectedParams))
    if (existing) {
      existing.claimed = true
      return Promise.resolve(existing)
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        method,
        after,
        expectedParams,
        resolve: notification => {
          notification.claimed = true
          resolve(notification)
        },
        reject,
        timer: setTimeout(() => {
          const index = this._notificationWaiters.indexOf(waiter)
          if (index !== -1) this._notificationWaiters.splice(index, 1)
          reject(new Error(`Timed out waiting for virtual server notification ${method}`))
        }, timeout),
      }
      this._notificationWaiters.push(waiter)
    })
  }

  getState() {
    return {
      host: this.host,
      port: this.port,
      started: this.started,
      connected: this.connected,
      initializeParams: this.initializeParams,
      requests: this.requests.map(request => ({ ...request })),
      notifications: this.notifications.map(notification => ({ ...notification })),
    }
  }

  setBuildStatus(status) {
    this.buildStatus = status
  }

  setProjectUris(projectUris) {
    this.projectUris = projectUris
  }

  _accept(socket) {
    if (this.stopped) {
      socket.destroy()
      return
    }

    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy()
    }
    this.socket = socket
    socket.unref()
    this.connected = true

    const connection = createMessageConnection(
      new StreamMessageReader(socket),
      new StreamMessageWriter(socket),
    )
    this.connection = connection

    connection.onRequest('initialize', params => {
      this.initializeParams = params
      this._recordRequest('initialize', params)
      return {
        capabilities: {
          textDocumentSync: { openClose: true, change: 1, save: { includeText: false } },
          completionProvider: { resolveProvider: true, triggerCharacters: ['.'] },
          definitionProvider: true,
          documentSymbolProvider: true,
          hoverProvider: true,
          referencesProvider: true,
          renameProvider: true,
          workspaceSymbolProvider: true,
          codeActionProvider: { resolveProvider: true },
          executeCommandProvider: { commands: [] },
        },
        serverInfo: { name: 'coc-java virtual server', version: '1.0.0' },
      }
    })

    connection.onNotification('initialized', params => {
      this._recordNotification('initialized', params)
      // coc.nvim registers the status handler from LanguageClient.onReady().
      // Give that promise a turn to settle before publishing readiness.
      this._statusTimer = setTimeout(() => {
        this._statusTimer = undefined
        if (this.stopped || !this.connected || this.connection !== connection) return
        this._sendNotification(connection, 'language/status', { type: 'Started', message: 'Started' })
        this._sendNotification(connection, 'language/status', { type: 'ServiceReady', message: 'ServiceReady' })
      }, 25)
      this._statusTimer.unref?.()
    })

    // A client may close its socket immediately after sending `exit`.  The
    // JSON-RPC writer reports that as a rejected write, which must not become
    // an unhandled rejection during coc-test teardown.
    connection.onError(() => {})

    connection.onRequest('shutdown', params => {
      this._recordRequest('shutdown', params)
      return null
    })

    connection.onNotification('exit', params => {
      this._recordNotification('exit', params)
      if (this.socket === socket) {
        this.connected = false
        this.socket = undefined
        this.connection = undefined
      }
      try {
        connection.dispose?.()
      } catch (_error) {
        // The client may already have closed the transport.
      }
      if (!socket.destroyed) socket.end()
    })

    // Keep a complete notification trace for assertions about configuration
    // updates and document lifecycle notifications. Named handlers above take
    // precedence, so initialized and exit are recorded only once.
    connection.onNotification((method, params) => {
      this._recordNotification(method, params)
    })

    connection.onRequest('workspace/executeCommand', params => {
      this._recordRequest('workspace/executeCommand', params)
      return this._executeCommand(params)
    })

    connection.onRequest('java/buildWorkspace', params => {
      this._recordRequest('java/buildWorkspace', params)
      return this.buildStatus
    })

    connection.onRequest('java/buildProjects', params => {
      this._recordRequest('java/buildProjects', params)
      return this.buildStatus
    })

    connection.onRequest('textDocument/documentSymbol', params => {
      this._recordRequest('textDocument/documentSymbol', params)
      const uri = params?.textDocument?.uri || 'file:///virtual/Greeter.java'
      return [{
        name: 'Greeter',
        kind: 5,
        range: range(0, 0),
        selectionRange: range(0, 13),
        children: [{
          name: 'greet',
          kind: 6,
          range: range(1, 2),
          selectionRange: range(1, 16),
        }],
        uri,
      }]
    })

    connection.onRequest('java/extendedDocumentSymbol', params => {
      this._recordRequest('java/extendedDocumentSymbol', params)
      const sourceUri = params?.textDocument?.uri || 'file:///virtual/Greeter.java'
      if (sourceUri.endsWith('/Empty.java')) return []
      const inheritedUri = sourceUri.replace(/Greeter\.java$/, 'BaseGreeter.java')
      return [
        {
          name: 'ExtendedGreeter',
          kind: 5,
          detail: 'class ExtendedGreeter extends Greeter',
          range: range(0, 0),
          selectionRange: range(0, 6),
          uri: sourceUri,
          children: [{
            name: 'greet',
            kind: 6,
            detail: 'public String greet()',
            range: range(3, 2),
            selectionRange: range(3, 16),
            uri: inheritedUri,
            children: [],
          }],
        },
        {
          name: 'GreeterContract',
          kind: 11,
          detail: 'interface GreeterContract',
          range: range(0, 0),
          selectionRange: range(0, 10),
          uri: 'file:///virtual/GreeterContract.java',
          children: [{
            name: 'greet',
            kind: 6,
            detail: 'String greet()',
            range: range(2, 2),
            selectionRange: range(2, 8),
            uri: inheritedUri,
            children: [],
          }],
        },
      ]
    })

    connection.onRequest('textDocument/definition', params => {
      this._recordRequest('textDocument/definition', params)
      return [{
        uri: params?.textDocument?.uri || 'file:///virtual/Greeter.java',
        range: range(0, 0),
      }]
    })

    connection.onRequest('textDocument/references', params => {
      this._recordRequest('textDocument/references', params)
      return []
    })

    connection.onRequest('textDocument/hover', params => {
      this._recordRequest('textDocument/hover', params)
      return { contents: [{ language: 'java', value: 'class Greeter' }] }
    })

    connection.onRequest('textDocument/completion', params => {
      this._recordRequest('textDocument/completion', params)
      if (this.completionSelectionPending) {
        throw new Error('A new completion request arrived before completion selection finished')
      }
      if (params?.textDocument?.uri?.endsWith('/PostfixTarget.java')) {
        return {
          isIncomplete: false,
          items: [{
            label: 'var',
            kind: 15,
            sortText: '999999999',
            insertText: '${field:newType(inner_expression)} ${1:var:newName(inner_expression)} = ${inner_expression};${0}',
            insertTextFormat: 2,
            command: {
              title: '',
              command: 'java.completion.onDidSelect',
              arguments: ['1', '0'],
            },
            data: { rid: '1', pid: '0' },
          }],
        }
      }
      return { isIncomplete: false, items: [] }
    })

    connection.onRequest('completionItem/resolve', item => {
      this._recordRequest('completionItem/resolve', item)
      if (item?.label !== 'var' || !item?.insertText?.includes('inner_expression')) return item
      const replacementRange = {
        start: { line: 2, character: 4 },
        end: { line: 2, character: 20 },
      }
      return {
        ...item,
        detail: 'Creates a new variable',
        textEdit: {
          range: replacementRange,
          newText: 'String ${1:string} = new String();${0}',
        },
        additionalTextEdits: [{ range: replacementRange, newText: '' }],
        data: undefined,
      }
    })

    connection.onRequest('textDocument/codeAction', params => {
      this._recordRequest('textDocument/codeAction', params)
      const uri = params?.textDocument?.uri
      if (!uri?.endsWith('/SnippetTarget.java')) return []
      return [{
        title: 'Insert Java snippet',
        kind: 'quickfix',
        data: { uri },
      }]
    })

    connection.onRequest('codeAction/resolve', action => {
      this._recordRequest('codeAction/resolve', action)
      const uri = action?.data?.uri
      return {
        ...action,
        edit: {
          documentChanges: [{
            textDocument: { uri, version: null },
            edits: [{
              range: {
                start: { line: 2, character: 4 },
                end: { line: 2, character: 9 },
              },
              snippet: {
                kind: 'snippet',
                value: [
                  'if (${1:ready}) {',
                  '      ${2|HashMap<Integer\\,Integer>,Map<Integer\\,Integer>|} values = null;',
                  '      System.out.println("$HOME\\\\logs");',
                  '      ${0}',
                  '    }',
                ].join('\n'),
              },
            }],
          }],
        },
      }
    })

    connection.onRequest('workspace/symbol', params => {
      this._recordRequest('workspace/symbol', params)
      return []
    })

    connection.onRequest('textDocument/formatting', params => {
      this._recordRequest('textDocument/formatting', params)
      return []
    })

    connection.onRequest('textDocument/rename', params => {
      this._recordRequest('textDocument/rename', params)
      return emptyEdit()
    })

    connection.onRequest('workspace/willRenameFiles', params => {
      this._recordRequest('workspace/willRenameFiles', params)
      return emptyEdit()
    })

    for (const method of [
      'java/classFileContents',
      'java/listOverridableMethods',
      'java/addOverridableMethods',
      'java/cleanup',
      'java/checkHashCodeEqualsStatus',
      'java/generateHashCodeEquals',
      'java/organizeImports',
      'java/checkToStringStatus',
      'java/generateToString',
      'java/resolveUnimplementedAccessors',
      'java/generateAccessors',
      'java/checkConstructorsStatus',
      'java/generateConstructors',
      'java/checkDelegateMethodsStatus',
      'java/generateDelegateMethods',
      'java/getChangeSignatureInfo',
      'java/getRefactorEdit',
      'java/inferSelection',
      'java/getMoveDestinations',
      'java/move',
      'java/searchSymbols',
      'java/findLinks',
    ]) {
      connection.onRequest(method, params => {
        this._recordRequest(method, params)
        return this._emptyResponse(method)
      })
    }

    connection.onClose(() => {
      if (this.socket === socket) {
        this.connected = false
        this.socket = undefined
        this.connection = undefined
      }
      void this.stop().catch(() => {})
    })
    connection.listen()
  }

  _executeCommand(params) {
    const command = params?.command
    switch (command) {
      case 'java.project.getSettings':
        return {}
      case 'java.project.getClasspaths':
        return { projectRoot: '', classpaths: [], modulepaths: [] }
      case 'java.project.isTestFile':
        return false
      case 'java.project.getAll':
        return this.projectUris
      case 'java.project.resolveSourceAttachment':
        return { attributes: {} }
      case 'java.project.updateSourceAttachment':
        return { attributes: {} }
      case 'java.project.addToSourcePath':
      case 'java.project.removeFromSourcePath':
        return { status: true }
      case 'java.project.changeImportedProjects':
      case 'java.project.import':
        return undefined
      case 'java.project.listSourcePaths':
        return { status: true, data: [] }
      case 'java.project.createModuleInfo':
        return undefined
      case 'java.getFullyQualifiedName':
        return 'com.example.Greeter'
      case 'java.completion.onDidSelect':
        this.completionSelectionPending = true
        return new Promise(resolve => {
          setTimeout(() => {
            this.completionSelectionPending = false
            resolve(undefined)
          }, 75)
        })
      default:
        return undefined
    }
  }

  _emptyResponse(method) {
    if (method === 'java/classFileContents') return ''
    if (method === 'java/listOverridableMethods' || method === 'java/resolveUnimplementedAccessors' || method === 'java/inferSelection' || method === 'java/getMoveDestinations' || method === 'java/searchSymbols' || method === 'java/findLinks') return []
    if (method.includes('Status')) return {}
    return emptyEdit()
  }

  _recordRequest(method, params) {
    const request = { method, params, claimed: false }
    this.requests.push(request)
    const requestIndex = this.requests.length - 1
    const waiterIndex = this._requestWaiters.findIndex(waiter => waiter.method === method
      && requestIndex >= waiter.after)
    if (waiterIndex !== -1) {
      const [waiter] = this._requestWaiters.splice(waiterIndex, 1)
      clearTimeout(waiter.timer)
      waiter.resolve(request)
    }
  }

  _sendNotification(connection, method, params) {
    try {
      Promise.resolve(connection.sendNotification(method, params)).catch(() => {})
    } catch (_error) {
      // The client may have disposed the connection between the two status
      // notifications; teardown is already complete in that case.
    }
  }

  _recordNotification(method, params) {
    const notification = { method, params, claimed: false }
    this.notifications.push(notification)
    const notificationIndex = this.notifications.length - 1
    const waiterIndex = this._notificationWaiters.findIndex(waiter => waiter.method === method
      && notificationIndex >= waiter.after && containsSubset(params, waiter.expectedParams))
    if (waiterIndex !== -1) {
      const [waiter] = this._notificationWaiters.splice(waiterIndex, 1)
      clearTimeout(waiter.timer)
      waiter.resolve(notification)
    }
  }
}

async function startVirtualServer(options) {
  return new VirtualLanguageServer(options).start()
}

module.exports = {
  VirtualLanguageServer,
  VirtualServer: VirtualLanguageServer,
  startVirtualServer,
}
