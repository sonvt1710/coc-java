import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)

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

const extensionPath = path.resolve(import.meta.dirname, '..')
const javaHome = await findJavaHome(extensionPath)
if (!javaHome) {
  throw new Error('coc-java integration tests could not find a JDK 17 or newer')
}

const dataHome = process.env.COC_DATA_HOME
if (!dataHome) throw new Error('coc-test did not define COC_DATA_HOME')

const storagePath = path.join(dataHome, 'extensions', 'coc-java-data')
const bundledJrePath = path.join(storagePath, `jdk-23.0.2-${process.platform}-${process.arch}`)
fs.mkdirSync(storagePath, { recursive: true })
fs.symlinkSync(javaHome, bundledJrePath, process.platform === 'win32' ? 'junction' : 'dir')

if (process.env.COC_JAVA_TEST_SERVER === 'virtual') {
  const { startVirtualServer } = require('./virtual-server.cjs')
  globalThis.__coc_java_test_server__ = await startVirtualServer()
}
