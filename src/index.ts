import type { Hooks, Plugin } from "@opencode-ai/plugin"

// Shell reserved words that open or close a compound statement. A segment starting with
// one is not a command at all - `snip then echo y` would try to exec a program called
// `then`. Leaving them alone also keeps the whole statement byte-identical, because
// every one of its segments starts with such a word. Requested in #27.
const SHELL_KEYWORDS = new Set([
  "if", "then", "elif", "else", "fi", "for", "while", "until", "do", "done",
  "case", "esac", "in", "function", "select", "time", "coproc",
  "{", "}", "[[", "]]", "!",
])

const UNPROXYABLE_COMMANDS = new Set([
  "cd", "source", ".", "export", "alias", "unset", "set", "shopt", "eval", "exec",
  ...SHELL_KEYWORDS,
])

function isSpace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r"
}

// Inside single quotes bash honours no escapes: the next `'` always closes the string.
function skipSingleQuoted(command: string, start: number): number {
  let i = start + 1
  while (i < command.length) {
    if (command[i] === "'") return i + 1
    i++
  }
  return command.length
}

function skipDoubleQuoted(command: string, start: number): number {
  let i = start + 1
  while (i < command.length) {
    if (command[i] === "\\") {
      i += 2
      continue
    }
    if (command[i] === '"') return i + 1
    i++
  }
  return command.length
}

// `$(...)`, consumed whole so a space inside it does not look like the end of a word.
// Unterminated input consumes the rest of the string, which is the safe side.
function skipParens(command: string, start: number): number {
  let i = start + 1
  let depth = 1
  while (i < command.length) {
    const char = command[i]
    if (char === "\\") {
      i += 2
      continue
    }
    if (char === "'") {
      i = skipSingleQuoted(command, i)
      continue
    }
    if (char === '"') {
      i = skipDoubleQuoted(command, i)
      continue
    }
    if (char === "(") {
      depth++
      i++
      continue
    }
    if (char === ")") {
      depth--
      if (depth === 0) return i + 1
      i++
      continue
    }
    i++
  }
  return command.length
}

// Index just past the shell word beginning at `start`: it ends at the first unquoted
// whitespace or metacharacter, and quoted sections and substitutions are consumed whole.
function readWord(command: string, start: number): number {
  let i = start
  while (i < command.length) {
    const char = command[i]
    if (char === "\\") {
      i += 2
      continue
    }
    if (char === "'") {
      i = skipSingleQuoted(command, i)
      continue
    }
    if (char === '"') {
      i = skipDoubleQuoted(command, i)
      continue
    }
    if (char === "$" && command[i + 1] === "(") {
      i = skipParens(command, i + 1)
      continue
    }
    if (char === "`") {
      const end = command.indexOf("`", i + 1)
      i = end === -1 ? command.length : end + 1
      continue
    }
    if (isSpace(char) || ";|&<>()".includes(char)) break
    i++
  }
  return i
}

/**
 * Index just past a leading `NAME=value` prefix, or 0 when there is none.
 *
 * Each value is read as one shell word, so a space inside quotes or inside `$(...)` no
 * longer ends the assignment early. This is #22: the old prefix regex was
 * `NAME=[^\s]* +`, and `[^\s]*` cannot cross a space, so `VAR1=$(echo hello) command`
 * matched only `VAR1=$(echo ` and the prefix was inserted *inside* the substitution. The
 * trailing whitespace is required, exactly as the old regex required it, so a bare
 * `FOO=bar` is not mistaken for a prefix.
 */
function readEnvPrefix(command: string): number {
  let i = 0
  while (i < command.length) {
    const name = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(command.slice(i))
    if (!name) return i
    let next = readWord(command, i + name[1].length + 1)
    const afterWord = next
    while (next < command.length && isSpace(command[next])) next++
    if (next === afterWord) return i
    i = next
  }
  return i
}

// Backslash quote removal for an unquoted heredoc word: `<<\EOF` is delimited by `EOF`.
// Without this every escaped delimiter looks unterminated, and the body scan would
// swallow the rest of the command. Quoted words are left verbatim, which is correct:
// inside quotes a backslash before an ordinary character is literal.
function unescapeHeredocWord(word: string): string {
  if (!word.includes("\\")) return word
  let out = ""
  for (let i = 0; i < word.length; i++) {
    if (word[i] === "\\" && i + 1 < word.length) {
      out += word[i + 1]
      i++
      continue
    }
    out += word[i]
  }
  return out
}

// `<<DELIM`, `<<-DELIM`, `<<'DELIM'`, `<<"DELIM"`. `<<<` is a here-string, not a
// heredoc, and is rejected by the caller before this runs.
function readHeredoc(command: string, start: number): { delimiter: string; next: number } | null {
  let i = start + 2
  if (command[i] === "-") i++
  const quote = command[i]
  if (quote === "'" || quote === '"') {
    const end = command.indexOf(quote, i + 1)
    if (end === -1 || end === i + 1) return null
    return { delimiter: command.slice(i + 1, end), next: end + 1 }
  }
  let end = i
  while (end < command.length && !/[\s;|<>&()]/.test(command[end])) end++
  if (end === i) return null
  return { delimiter: unescapeHeredocWord(command.slice(i, end)), next: end }
}

// Heredoc bodies start on the line after the `<<DELIM` and run to a line equal to the
// delimiter. Everything between is payload: no operator is recognised there and no text
// is rewritten. An unterminated heredoc swallows the remainder rather than rewriting it,
// because losing filtering is recoverable and corrupting a file is not.
function consumeHeredocBodies(command: string, start: number, pending: string[]): number {
  let i = start
  for (const delimiter of pending) {
    let terminated = false
    while (i <= command.length) {
      let lineEnd = command.indexOf("\n", i)
      if (lineEnd === -1) lineEnd = command.length
      if (command.slice(i, lineEnd) === delimiter) {
        i = lineEnd
        terminated = true
        break
      }
      i = lineEnd + 1
      if (lineEnd === command.length) break
    }
    if (!terminated || i > command.length) return command.length
  }
  pending.length = 0
  return i
}

// A `#` only opens a comment when it starts a word. This is not cosmetic: a comment holds
// no quotes, so an apostrophe in `ls # don't delete; keep this` would otherwise open a
// string that never closes and every operator after it would be missed.
function isWordStart(command: string, index: number): boolean {
  if (index === 0) return true
  const previous = command[index - 1]
  return previous === undefined || isSpace(previous) || ";|&()".includes(previous)
}

/**
 * Split a command string on shell operators (;, &&, ||, &) while respecting
 * single and double quotes. Operators inside quoted strings (e.g. the
 * semicolons inside `ssh host "cmd1; cmd2"`) are NOT treated as separators.
 *
 * Returns alternating [command, operator, command, operator, ...] segments,
 * matching the behaviour of String.split() with a capturing group.
 */
function splitOnOperators(command: string): string[] {
  const segments: string[] = []
  let current = ""
  let inSingleQuote = false
  let inDoubleQuote = false
  // Delimiters of heredocs opened on the current line, and depth of `((`, where `<<` is
  // a left shift and NOT a heredoc operator. Armed there, a heredoc would swallow the
  // rest of the command, so the inner `((x=1<<4))` would leave it unfiltered.
  const pending: string[] = []
  let arith = 0
  let i = 0

  while (i < command.length) {
    const char = command[i]
    const next = command[i + 1]

    // Track quote state
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      current += char
      i++
      continue
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      current += char
      i++
      continue
    }

    // Only split on operators outside quotes
    if (!inSingleQuote && !inDoubleQuote) {
      // An unquoted backslash escapes the next character, so `\;` is a literal semicolon
      // rather than a separator (`find -exec {} \;`).
      if (char === "\\") {
        current += char + (next ?? "")
        i += 2
        continue
      }
      if (char === "#" && isWordStart(command, i)) {
        // A comment runs to the end of its line, so the shell reads no operator in it and
        // no quote in it. Stop on the newline, not past it: the newline still closes a
        // heredoc opened earlier on the line.
        const newline = command.indexOf("\n", i)
        const end = newline === -1 ? command.length : newline
        current += command.slice(i, end)
        i = end
        continue
      }
      if (char === "(" && next === "(") {
        arith++
        current += char + next
        i += 2
        continue
      }
      if (char === ")" && next === ")" && arith > 0) {
        arith--
        current += char + next
        i += 2
        continue
      }
      if (char === "<" && next === "<" && command[i + 2] !== "<" && arith === 0) {
        const heredoc = readHeredoc(command, i)
        if (heredoc) {
          pending.push(heredoc.delimiter)
          current += command.slice(i, heredoc.next)
          i = heredoc.next
          continue
        }
      }
      if (char === "\n") {
        // The newline closes the line that carried `<<DELIM`: swallow the bodies.
        if (pending.length > 0) {
          const end = consumeHeredocBodies(command, i + 1, pending)
          current += command.slice(i, end)
          i = end
          continue
        }
        arith = 0
        current += char
        i++
        continue
      }

      // `&&`, `||` or `;`. The `||` test compares a single character, so both operators
      // are detected by the same branch.
      if ((char === "&" && next === "&") || (char === "|" && next === "|") || char === ";") {
        const width = char === ";" ? 1 : 2
        let op = ""
        while (current && isSpace(current[current.length - 1])) {
          op = current[current.length - 1] + op
          current = current.slice(0, -1)
        }
        op += command.slice(i, i + width)
        i += width
        while (i < command.length && isSpace(command[i])) {
          op += command[i]
          i++
        }
        segments.push(current)
        segments.push(op)
        current = ""
        continue
      }

      // & (background operator, not &&, not part of redirection like 2>&1)
      if (char === "&" && next !== "&") {
        // Only split if preceded by whitespace (avoids 2>&1, 1>&2, etc.)
        if (current && isSpace(current[current.length - 1])) {
          let op = current[current.length - 1]
          current = current.slice(0, -1)
          op += "&"
          i++
          while (i < command.length && isSpace(command[i])) {
            op += command[i]
            i++
          }
          segments.push(current)
          segments.push(op)
          current = ""
          continue
        }
      }
    }

    current += char
    i++
  }

  if (current) segments.push(current)
  return segments
}

function isOperatorSegment(segment: string): boolean {
  const trimmed = segment.trim()
  return trimmed === "&&" || trimmed === "||" || trimmed === ";" || trimmed === "&"
}

function snipCommand(command: string): string {
  const envPrefix = command.slice(0, readEnvPrefix(command))
  const bareCmd = command.slice(envPrefix.length).trim()
  if (!bareCmd) return command
  if (UNPROXYABLE_COMMANDS.has(bareCmd.split(/\s+/)[0])) return command
  return `${envPrefix}snip ${bareCmd}`
}

export const toolExecuteBefore: NonNullable<Hooks["tool.execute.before"]> = async (input, output) => {
  if (input.tool !== "bash") return

  const command = output.args.command
  if (!command || typeof command !== "string") return
  if (command.startsWith("snip ")) return

  if (findFirstPipe(command) !== -1) {
    const pipeIdx = findFirstPipe(command)
    const firstCmd = command.slice(0, pipeIdx).trimEnd()
    const rest = command.slice(pipeIdx)
    output.args.command = snipCommand(firstCmd) + ' ' + rest
    return
  }

  const segments = splitOnOperators(command)

  if (segments.length === 1) {
    output.args.command = snipCommand(command)
    return
  }

  output.args.command = segments
    .map((segment) => isOperatorSegment(segment) ? segment : snipCommand(segment))
    .join("")
}

function findFirstPipe(command: string): number {
  let inSingleQuote = false
  let inDoubleQuote = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
    } else if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
    } else if (char === '|' && !inSingleQuote && !inDoubleQuote) {
      if (command[i + 1] === '|' || (i > 0 && command[i - 1] === '|')) {
        i++
        continue
      }
      return i
    }
  }

  return -1
}

export const SnipPlugin: Plugin = async ({ $ }) => {
  try {
    await $`which snip`.quiet()
  } catch {
    console.warn("[snip] snip binary not found in PATH — plugin disabled")
    return {}
  }

  return {
    "tool.execute.before": toolExecuteBefore,
  }
}

export default SnipPlugin
