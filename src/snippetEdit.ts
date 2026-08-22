interface SnippetEditLike {
  snippet?: {
    value?: string
  }
}

interface TextDocumentEditLike {
  textDocument?: unknown
  edits?: SnippetEditLike[]
}

interface SnippetCodeActionLike {
  edit?: {
    documentChanges?: unknown[]
  }
}

/**
 * JDT LS uses `${...}` for placeholders and otherwise returns Java literals.
 * Escape those literals for a TextMate snippet while preserving escaped
 * commas inside choices.
 */
export function escapeSnippetLiterals(value: string): string {
  return value
    .replace(/\\(?!,)/g, '\\\\')
    .replace(/\$(?!\{)/g, '\\$')
}

/**
 * Keep the protocol-native SnippetTextEdit shape for coc.nvim while applying
 * the literal escaping used by the upstream Java extension.
 */
export function prepareSnippetCodeAction<T extends SnippetCodeActionLike>(action: T): T {
  const documentChanges = action?.edit?.documentChanges
  if (!Array.isArray(documentChanges)) return action
  for (const change of documentChanges) {
    const documentEdit = change as TextDocumentEditLike
    if (!documentEdit?.textDocument || !Array.isArray(documentEdit.edits)) continue
    for (const edit of documentEdit.edits) {
      if (typeof edit?.snippet?.value === 'string') {
        edit.snippet.value = escapeSnippetLiterals(edit.snippet.value)
      }
    }
  }
  return action
}
