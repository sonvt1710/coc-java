'use strict'

import { commands, ConfigurationTarget, ExtensionContext, window, workspace } from 'coc.nvim'
import { getRuntime, IJavaRuntime } from 'jdk-utils'
import * as path from 'path'
import packageJson from '../package.json'
import { Commands } from './commands'

const LAST_SELECTED_DIRECTORY = 'java.runtimes.lastSelectedDirectory'

interface RuntimeConfiguration {
  name: string
  path: string
  [key: string]: unknown
}

/**
 * Return the runtime names contributed by the manifest. Keeping this derived
 * from package.json avoids a second list that can drift from the schema.
 */
export function getRuntimeNames(): string[] {
  const properties = (packageJson as any)?.contributes?.configuration?.properties
  const names = properties?.['java.configuration.runtimes']?.items?.properties?.name?.enum
  return Array.isArray(names) ? names.filter((name): name is string => typeof name === 'string') : []
}

/**
 * Whether a detected JDK can implement the requested execution environment.
 */
export function isCompatibleRuntime(runtime: IJavaRuntime, runtimeName: string): boolean {
  if (!runtime?.version) {
    return true
  }

  const majorVersion = runtime.version.major
  if (majorVersion === 8) {
    return runtimeName === 'JavaSE-1.8'
  }

  const versionMatch = /[0-9]+/g.exec(runtimeName)
  return !!versionMatch && majorVersion >= parseInt(versionMatch[0], 10)
}

async function requestRuntimeDirectory(defaultValue: string): Promise<string | undefined> {
  const selected = await workspace.nvim.callAsync('coc#util#with_callback', [
    'input',
    ['Select JDK Directory: ', defaultValue ?? '', 'dir'],
  ]) as string
  return selected || undefined
}

export namespace JavaRuntimes {
  export function initialize(context: ExtensionContext): void {
    context.subscriptions.push(commands.registerCommand(Commands.ADD_JAVA_RUNTIME, async () => {
      const lastSelectedDirectory = context.workspaceState.get<string>(LAST_SELECTED_DIRECTORY)
      const directory = await requestRuntimeDirectory(lastSelectedDirectory || workspace.cwd)
      if (!directory) {
        return
      }

      await context.workspaceState.update(LAST_SELECTED_DIRECTORY, path.dirname(directory))
      const runtime = await getRuntime(directory, { withVersion: true })
      if (!runtime) {
        window.showErrorMessage(`Invalid JDK Directory ${directory}`)
        return
      }

      const candidates = getRuntimeNames().filter(name => isCompatibleRuntime(runtime, name)).reverse()
      if (!candidates.length) {
        window.showErrorMessage('No compatible environment available')
        return
      }

      const name = await window.showQuickPick(candidates, { title: 'Select Java Runtime' })
      if (!name) {
        return
      }

      const configured = workspace.getConfiguration().get<RuntimeConfiguration[]>('java.configuration.runtimes')
      const runtimes = Array.isArray(configured) ? configured.slice() : []
      const newRuntime: RuntimeConfiguration = { name, path: directory }
      const index = runtimes.findIndex(runtime => runtime?.name === name)
      if (index >= 0) {
        runtimes[index] = newRuntime
      } else {
        runtimes.push(newRuntime)
      }
      await workspace.getConfiguration().update('java.configuration.runtimes', runtimes, ConfigurationTarget.Global)
      window.showInformationMessage(`JDK Directory ${directory} added`)
    }))
  }
}
