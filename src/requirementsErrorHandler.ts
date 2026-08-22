import { commands, window } from 'coc.nvim'

export interface RequirementsError {
  message: string
  label?: string
  command?: string
  commandParam?: unknown
}

export async function showRequirementsError(error: RequirementsError): Promise<void> {
  const items = error.label ? [error.label] : []
  const selection = await window.showErrorMessage(error.message, ...items)
  if (error.label && error.label === selection && error.command) {
    await commands.executeCommand(error.command, error.commandParam)
  }
}
