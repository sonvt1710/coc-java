const fs = require('node:fs')
const path = require('node:path')

let extension
let virtualServer

async function findJavaHome(extensionPath) {
  const { findRuntimes, getRuntime } = require(path.join(extensionPath, 'node_modules', 'jdk-utils'))
  const configuredHomes = [
    process.env.COC_JAVA_TEST_JAVA_HOME,
    process.env.JAVA_HOME,
    process.env.JDK_HOME,
  ].filter(Boolean)

  for (const javaHome of configuredHomes) {
    try {
      const runtime = await getRuntime(javaHome, { withVersion: true })
      if (runtime?.version?.major >= 17) return runtime.homedir
    } catch (_error) {
      // Fall through to automatic runtime discovery.
    }
  }

  const runtimes = await findRuntimes({ checkJavac: true, withVersion: true })
  return runtimes
    .filter(runtime => runtime.version?.major >= 17)
    .sort((a, b) => b.version.major - a.version.major)[0]?.homedir
}

exports.activate = async function activate(context) {
  const javaHome = await findJavaHome(context.extensionPath)
  if (!javaHome) {
    throw new Error('coc-java integration tests could not find a JDK 17 or newer')
  }

  const bundledJrePath = path.join(
    context.storagePath,
    `jdk-23.0.2-${process.platform}-${process.arch}`,
  )
  fs.mkdirSync(context.storagePath, { recursive: true })
  fs.symlinkSync(javaHome, bundledJrePath, process.platform === 'win32' ? 'junction' : 'dir')

  if (process.env.COC_JAVA_TEST_SERVER === 'virtual') {
    const { startVirtualServer } = require('./virtual-server.cjs')
    virtualServer = await startVirtualServer()
  }

  try {
    extension = require(path.join(context.extensionPath, 'lib', 'index.js'))
    const api = await extension.activate(context)
    if (!virtualServer) return api
    return {
      ...api,
      $testServer: {
        getState: () => virtualServer.getState(),
        waitForRequest: (method, timeout) => virtualServer.waitForRequest(method, timeout),
      },
    }
  } catch (error) {
    await virtualServer?.stop()
    virtualServer = undefined
    throw error
  }
}

exports.deactivate = async function deactivate() {
  try {
    await extension?.deactivate?.()
  } finally {
    await virtualServer?.stop()
    virtualServer = undefined
  }
}
