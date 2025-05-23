'use strict'

import {Command, commands, Uri, ExtensionContext, window, workspace} from 'coc.nvim'
import * as fse from 'fs-extra'
import * as glob from 'glob'
import * as path from 'path'
import * as semver from 'semver'
import {apiManager} from './apiManager'
import {Commands} from './commands'
import {createLogger} from './log'
import {runtimeStatusBarProvider} from './runtimeStatusBarProvider'
import {getAllJavaProjects} from './utils'

export const JAVA_LOMBOK_PATH = "java.lombokPath"

const lombokJarRegex = /lombok-?\d?.*\.jar$/
const unkownVersion = '999.999.999'
const compatibleVersion = '1.18.0'
let activeLombokPath: string = undefined
let isLombokStatusBarInitialized: boolean = false
let isLombokCommandInitialized: boolean = false
let isExtensionLombok: boolean = false		// whether use extension's Lombok or not
let projectLombokPath: string = undefined	// the project's Lombok classpath

export function isLombokSupportEnabled(): boolean {
  return workspace.getConfiguration().get("java.jdt.ls.lombokSupport.enabled")
}

export function isLombokImported(): boolean {
  return projectLombokPath !== undefined
}

export function updateActiveLombokPath(path: string) {
  activeLombokPath = path
}

export function isLombokActive(context: ExtensionContext): boolean {
  return activeLombokPath !== undefined
}

export function cleanupLombokCache(context: ExtensionContext) {
  context.workspaceState.update(JAVA_LOMBOK_PATH, undefined)
}

function getExtensionLombokPath(): string {
  const lombokHome = path.resolve(__dirname, '../server')
  const lombokJar: Array<string> = glob.sync('lombok*.jar', {cwd: lombokHome})

  if (lombokJar === undefined || lombokJar.length === 0) {
    window.showWarningMessage(`Lombok missing in extension path`)
    return
  }

  const lombokJarPath = `${lombokHome}/${lombokJar[0]}`
  if (!fse.existsSync(lombokJarPath)) {
    window.showWarningMessage(`Lombok found but not accessible`)
    return
  }

  return lombokJarPath
}

function lombokPath2Version(lombokPath: string): string {
  if (!lombokPath) return ''
  const matches = lombokJarRegex.exec(lombokPath)
  if (matches.length > 0) {
    return matches[0].split('.jar')[0]
  }
  window.showWarningMessage(`Lombok ${lombokPath} jar name mismatch`)
  return "lombok"
}

function lombokPath2VersionNumber(lombokPath: string): string {
  const lombokVersionTag = lombokPath2Version(lombokPath).split('-')
  if (lombokVersionTag?.length > 1) {
    return lombokVersionTag[1]
  }
  window.showWarningMessage(`Lombok ${lombokPath} missing version tag`)
  return unkownVersion
}

export function getLombokVersion(): string {
  return lombokPath2Version(activeLombokPath)
}

function isCompatibleLombokVersion(currentVersion: string): boolean {
  return semver.gte(currentVersion, compatibleVersion)
}

export function addLombokParam(context: ExtensionContext, params: string[]) {
  // Exclude user setting Lombok agent parameter
  const reg = /-javaagent:.*[\\|/]lombok.*\.jar/
  const deleteIndex = []
  for (let i = 0; i < params.length; i++) {
    if (reg.test(params[i])) {
      deleteIndex.push(i)
    }
  }

  const lastMatchedParam = params[deleteIndex[deleteIndex.length - 1]]

  for (let i = deleteIndex.length - 1; i >= 0; i--) {
    params.splice(deleteIndex[i], 1)
  }
  // add -javaagent arg to support Lombok.
  // use the extension's Lombok version by default.
  isExtensionLombok = true
  let lombokJarPath: string = context.workspaceState.get(JAVA_LOMBOK_PATH)

  // use the supplied lombok jar-path if the above statement resolves to
  // undefined
  if (!lombokJarPath && !!lastMatchedParam) {
    lombokJarPath = lastMatchedParam.replace('-javaagent:', '')
  }

  if (lombokJarPath && fse.existsSync(lombokJarPath)) {
    if (isCompatibleLombokVersion(lombokPath2VersionNumber(lombokJarPath))) {
      isExtensionLombok = false
    }
    else {
      cleanupLombokCache(context)
      window.showWarningMessage(`The configured lombok ${lombokPath2VersionNumber(lombokJarPath)} is not supported, falling back ${lombokPath2VersionNumber(getExtensionLombokPath())}`)
    }
  }

  if (isExtensionLombok) {
    lombokJarPath = getExtensionLombokPath()
  }

  if (!lombokJarPath) {
    window.showWarningMessage(`Could not resolve valid lombok jar from vmargs or builtin.`)
    return
  }

  const lombokAgentParam = `-javaagent:${lombokJarPath}`
  params.push(lombokAgentParam)
  updateActiveLombokPath(lombokJarPath)
  createLogger().info(`Starting server with lombok support ${lombokJarPath}`)
}

export async function checkLombokDependency(context: ExtensionContext, projectUri?: Uri) {
  if (!isLombokSupportEnabled()) {
    return
  }
  let versionChange: boolean = false
  let lombokFound: boolean = false
  let currentLombokVersion: string = undefined
  let previousLombokVersion: string = undefined
  let currentLombokClasspath: string = undefined
  const projectUris: string[] = projectUri ? [projectUri.toString()] : await getAllJavaProjects()
  for (const projectUri of projectUris) {
    const classpathResult = await apiManager.getApiInstance().getClasspaths(projectUri, {scope: 'test'})
    for (const classpath of classpathResult.classpaths) {
      if (lombokJarRegex.test(classpath)) {
        currentLombokClasspath = classpath
        if (activeLombokPath && !isExtensionLombok) {
          currentLombokVersion = lombokPath2Version(classpath)
          previousLombokVersion = lombokPath2Version(activeLombokPath)
          if (currentLombokVersion !== previousLombokVersion) {
            versionChange = true
          }
        }
        lombokFound = true
        break
      }
    }
    if (lombokFound) {
      break
    }
  }
  projectLombokPath = currentLombokClasspath
  /* if projectLombokPath is undefined, it means that this project has not imported Lombok.
   * We don't need initalize Lombok status bar in this case.
  */
  if (!isLombokStatusBarInitialized && projectLombokPath) {
    if (!isLombokCommandInitialized) {
      registerLombokConfigureCommand(context)
      isLombokCommandInitialized = true
    }
    runtimeStatusBarProvider.initializeLombokStatusBar()
    isLombokStatusBarInitialized = true
  }
  if (isLombokStatusBarInitialized && !projectLombokPath) {
    runtimeStatusBarProvider.destroyLombokStatusBar()
    isLombokStatusBarInitialized = false
    cleanupLombokCache(context)
  }
  if (versionChange && !isExtensionLombok) {
    context.workspaceState.update(JAVA_LOMBOK_PATH, currentLombokClasspath)
    const msg = `Lombok version changed from ${previousLombokVersion.split('.jar')[0].split('-')[1]} to ${currentLombokVersion.split('.jar')[0].split('-')[1]} \
						. Do you want to reload the window to load the new Lombok version?`
    const action = 'Reload'
    const restartId = Commands.RELOAD_WINDOW
    window.showInformationMessage(msg, action).then((selection) => {
      if (action === selection) {
        commands.executeCommand(restartId)
      }
    })
  }
}

export function registerLombokConfigureCommand(context: ExtensionContext) {
  context.subscriptions.push(commands.registerCommand(Commands.LOMBOK_CONFIGURE, async (buildFilePath: string) => {
    const extensionLombokPath: string = getExtensionLombokPath()
    if (!extensionLombokPath || !projectLombokPath) {
      return
    }
    const extensionItemLabel = 'Use Extension\'s Version'
    const extensionItemLabelCheck = `• ${extensionItemLabel}`
    const projectItemLabel = 'Use Project\'s Version'
    const projectItemLabelCheck = `• ${projectItemLabel}`
    const lombokPathItems = [
      {
        label: isExtensionLombok ? extensionItemLabelCheck : extensionItemLabel,
        description: lombokPath2Version(extensionLombokPath)
      },
      {
        label: isExtensionLombok ? projectItemLabel : projectItemLabelCheck,
        description: lombokPath2Version(projectLombokPath),
        detail: projectLombokPath
      }
    ]
    const selectLombokPathItem = await window.showQuickPick(lombokPathItems, {
      placeholder: 'Select the Lombok version used in the Java extension'
    })
    let shouldReload: boolean = false
    if (!selectLombokPathItem) {
      return
    }
    if (selectLombokPathItem.label === extensionItemLabel || selectLombokPathItem.label === extensionItemLabelCheck) {
      if (!isExtensionLombok) {
        shouldReload = true
        cleanupLombokCache(context)
      }
    }
    else if (isExtensionLombok) {
      const projectLombokVersion = lombokPath2VersionNumber(projectLombokPath)
      if (!isCompatibleLombokVersion(projectLombokVersion)) {
        const msg = `The project's Lombok version ${projectLombokVersion} is not supported. Falling back to the built-in Lombok version in the extension.`
        window.showWarningMessage(msg)
        return
      }
      else {
        shouldReload = true
        context.workspaceState.update(JAVA_LOMBOK_PATH, projectLombokPath)
      }
    }
    if (shouldReload) {
      const msg = `The Lombok version used in Java extension has changed, please reload the window.`
      const action = 'Reload'
      const restartId = Commands.RELOAD_WINDOW
      window.showInformationMessage(msg, action).then((selection) => {
        if (action === selection) {
          commands.executeCommand(restartId)
        }
      })
    }
    else {
      const msg = `Current Lombok version is ${isExtensionLombok ? 'extension\'s' : 'project\'s'} version. Nothing to do.`
      window.showInformationMessage(msg)
    }
  }, null, true))
}

export namespace LombokVersionItemFactory {
  export function create(text: string | undefined): any {
    return undefined
  }

  export function update(item: any, text: string): void {
    item.text = text
  }

  function getLombokChangeCommand(): Command {
    return {
      title: `Configure Lombok Version`,
      command: Commands.LOMBOK_CONFIGURE,
    }
  }
}
