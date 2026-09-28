import type { Hooks, Plugin } from "@opencode-ai/plugin"

const UNPROXYABLE_COMMANDS = new Set([
  "cd", "source", ".", "export", "alias", "unset", "set", "shopt", "eval", "exec",
])

// Keywords that open a compound statement. When any segment of a command starts with
// one, the whole command is left byte-identical: a `for`/`if`/`case` construct is not a
// list of independently proxyable commands, and prefixing part of it would make the
// shell run a bogus command (`snip then echo y`, or `snip b)` inside a case arm).
const COMPOUND_COMMAND_KEYWORDS = new Set([
  "for", "while", "until", "if", "case", "select", "function", "time", "{", "}", "!",
])

function isSpace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r"
}

// A `#` only opens a comment when it starts a word: at the start of the command, or
// after whitespace or a separator. `grep '#' f` and `echo a#b` are unaffected.
function isWordStart(command: string, index: number): boolean {
  if (index === 0) return true
  const previous = command[index - 1]
  return previous === undefined || isSpace(previous) || ";|&()".includes(previous)
}

// Inside single quotes bash honours no escapes and the next `'` always closes the
// string. Inside double quotes a backslash escapes the next character, so the `"` in
// `echo "it\"s; fine"` is part of the argument and does not end the string.
function skipQuoted(command: string, start: number, quote: string): number {
  let i = start + 1
  while (i < command.length) {
    const char = command[i]
    if (quote === '"' && char === "\\") {
      i += 2
      continue
    }
    if (char === quote) return i + 1
    i++
  }
  return command.length
}

// `$(...)` with balanced parens, so a space inside it does not look like the end of a
// word. Unterminated input consumes the rest of the string, which is the safe side.
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
      i = skipQuoted(command, i, "'")
      continue
    }
    if (char === '"') {
      i = skipQuoted(command, i, '"')
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

// A command substitution has its own quoting context, inside or outside quotes, so it
// is consumed whole. Otherwise the inner `"` of `echo "$(printf "a;b")"` reads as the
// end of the outer string and exposes the inner `;` as an operator.
function skipSubstitution(command: string, start: number): number {
  if (command[start + 1] === "(") return skipParens(command, start + 1)
  const end = command.indexOf("`", start + 1)
  return end === -1 ? command.length : end + 1
}

// Index just past the shell word beginning at `start`. Quoted sections and
// substitutions are consumed whole, so the word ends only at unquoted whitespace or at
// a metacharacter that really is one.
//
// A `(` in the first position is an array assignment, `NAME=(a b c)`, and is consumed
// with balanced parens. Without that the word would end at the `(` and the assignment
// would be split at its first space, so `ARR=(a b c)` came out as `ARR=(a snip b c)` —
// a four-element array. Breaking there instead of tracking the parens turns the same
// input into `snip ARR=(a b c)`, which bash rejects with a syntax error, so neither
// outcome is acceptable and the parens have to be counted.
function readWord(command: string, start: number): number {
  let i = start
  while (i < command.length) {
    const char = command[i]
    if (char === "\\") {
      i += 2
      continue
    }
    if (char === "'") {
      i = skipQuoted(command, i, "'")
      continue
    }
    if (char === '"') {
      i = skipQuoted(command, i, '"')
      continue
    }
    if (char === "$" && command[i + 1] === "(") {
      i = skipParens(command, i + 1)
      continue
    }
    if (char === "(" && i === start) {
      i = skipParens(command, i)
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
 * longer ends the assignment early. The old prefix pattern was `NAME=[^\s]* +`, and
 * `[^\s]*` cannot cross a space, so `VAR1=$(echo hello) command` matched only
 * `VAR1=$(echo ` and the prefix was inserted *inside* the substitution. Trailing
 * whitespace is required, exactly as the old pattern required it, so `FOO=bar` is not
 * mistaken for a prefix to a command.
 *
 * An assignment that runs to the end of the segment is reported as the whole segment,
 * so the caller sees an empty command and leaves it alone. `FOO=bar` and `ARR=(a b c)`
 * are assignments, not commands, and prefixing them would turn `FOO=bar` into
 * `snip FOO=bar` — which bash reads as running `snip` with `FOO` set and no arguments.
 */
function readEnvPrefix(command: string): number {
  let i = 0
  while (i < command.length) {
    const name = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(command.slice(i))
    if (!name) return i
    const end = readWord(command, i + name[1].length + 1)
    let next = end
    while (next < command.length && isSpace(command[next])) next++
    // No whitespace and no command: the assignment is the entire segment.
    if (next === end) return end === command.length ? end : i
    i = next
  }
  return i
}

// Backslash quote removal for an unquoted heredoc word: `<<\EOF` and `<<E\OF` are both
// delimited by `EOF`, and the terminator line never carries the escaping backslash.
// Without this every escaped delimiter looks unterminated and the body scan swallows
// the rest of the command, so the line after the terminator silently stops being
// filtered. Quoted words are left verbatim, which is correct: inside quotes a
// backslash before an ordinary character is literal, so `<<'E\OF'` is delimited by
// `E\OF`.
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
// is rewritten. Without this, `cat <<'EOF' > conf` with `key = a; b` in the body is
// written to disk as `key = a; snip b`, and the command still exits 0. An unterminated
// heredoc swallows the remainder rather than being rewritten, because losing filtering
// is recoverable and corrupting a file is not.
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
  // Delimiters of heredocs opened on the current line, and the depth of `((`, where
  // `<<` is a left shift and not a heredoc operator. Armed there, a heredoc would
  // swallow the rest of the command.
  const pending: string[] = []
  let arith = 0
  let i = 0

  while (i < command.length) {
    const char = command[i]
    const next = command[i + 1]

    if (!inSingleQuote && !inDoubleQuote) {
      // A comment runs to the end of its line, and it contains no quotes: an
      // apostrophe in `ls # don't delete; keep this` must not open a string that never
      // closes and suppress every later operator. Stop on the newline, not past it,
      // because the newline still closes a heredoc opened earlier on the line.
      if (char === "#" && isWordStart(command, i)) {
        const newline = command.indexOf("\n", i)
        const end = newline === -1 ? command.length : newline
        current += command.slice(i, end)
        i = end
        continue
      }
      // An unquoted backslash escapes the next character, so `\;` in
      // `find -exec {} \;` is a literal semicolon and not a separator.
      if (char === "\\") {
        current += char + (next ?? "")
        i += 2
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
    }

    // A substitution has its own quoting context, inside or outside quotes. Inside
    // single quotes it is literal, so it is deliberately not handled there.
    if (!inSingleQuote && ((char === "$" && next === "(") || char === "`")) {
      const end = skipSubstitution(command, i)
      current += command.slice(i, end)
      i = end
      continue
    }
    if (inDoubleQuote && char === "\\") {
      current += char + (next ?? "")
      i += 2
      continue
    }

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
      // && or ||
      if ((char === "&" && next === "&") || (char === "|" && next === "|") || char === ";") {
        const width = char === ";" ? 1 : 2
        let op = ""
        while (current && /\s/.test(current[current.length - 1])) {
          op = current[current.length - 1] + op
          current = current.slice(0, -1)
        }
        op += command.slice(i, i + width)
        i += width
        while (i < command.length && command[i] === " ") {
          op += " "
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
        if (current && /\s/.test(current[current.length - 1])) {
          let op = current[current.length - 1]
          current = current.slice(0, -1)
          op += "&"
          i++
          while (i < command.length && command[i] === " ") {
            op += " "
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

function isCompoundCommand(segments: string[]): boolean {
  return segments.some((segment, index) => {
    if (index % 2 === 1) return false
    const first = segment.trim().split(/\s+/)[0]
    return first !== undefined && COMPOUND_COMMAND_KEYWORDS.has(first)
  })
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

  if (isCompoundCommand(segments)) {
    output.args.command = command
    return
  }

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

    // Same rule as the splitter: outside quotes a backslash escapes the next
    // character, so `\'` does not open a string and `\|` is a literal pipe rather than
    // an operator. Missed here the phantom string also hides a real pipe, and the
    // head of the pipeline is then left unwrapped.
    if (char === "\\" && !inSingleQuote) {
      i++
      continue
    }

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
