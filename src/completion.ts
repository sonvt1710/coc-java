import { CompletionItem, CompletionList, InsertReplaceEdit } from 'coc.nvim'
import { Commands } from './commands'

export const JAVA_COMPLETION_ON_DID_SELECT = 'java.completion.onDidSelect'

function samePosition(
  left: { line: number; character: number },
  right: { line: number; character: number },
): boolean {
  return left.line === right.line && left.character === right.character
}

function isJavaPostfixCompletion(item: CompletionItem): boolean {
  return typeof item.insertText === 'string' && item.insertText.includes('inner_expression')
}

/** Keep JDT's internal template variables out of the completion word shown by Coc. */
export function prepareJavaCompletionItems(
  result: CompletionItem[] | CompletionList | null | undefined,
): CompletionItem[] | CompletionList | null | undefined {
  if (!result) return result
  const items = Array.isArray(result) ? result : result.items
  for (const item of items) {
    if (item.command?.command === JAVA_COMPLETION_ON_DID_SELECT) {
      item.command = {
        ...item.command,
        command: Commands.EXECUTE_WORKSPACE_COMMAND,
        arguments: [JAVA_COMPLETION_ON_DID_SELECT, ...(item.command.arguments ?? [])],
      }
    }
    if (isJavaPostfixCompletion(item)) {
      const data = item.data && typeof item.data === 'object' ? item.data : {}
      item.data = { ...data, word: item.label }
    }
  }
  return result
}

/**
 * JDT LS resolves postfix completions with a text edit for the whole
 * expression and, for clients supporting resolved additional edits, a
 * redundant deletion of that same range. LSP requires those edits not to
 * overlap, so keep the replacement and discard only the duplicate deletion.
 */
export function normalizeJavaCompletionItem(item: CompletionItem): CompletionItem {
  if (!isJavaPostfixCompletion(item) || !item.textEdit || InsertReplaceEdit.is(item.textEdit)) {
    return item
  }

  const replacement = item.textEdit
  item.additionalTextEdits = item.additionalTextEdits?.filter(edit => {
    return edit.newText !== ''
      || !samePosition(edit.range.start, replacement.range.start)
      || !samePosition(edit.range.end, replacement.range.end)
  })
  return item
}
