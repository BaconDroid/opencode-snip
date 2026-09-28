import type { Hooks, Plugin } from "@opencode-ai/plugin"

const ENV_VAR_RE = /^([A-Za-z_][A-Za-z0-9_]*=[^\s]* +)*/
// Keywords that open a compound statement. When a command contains one, the whole
// command is left byte-identical: a `for`/`if`/`case` construct is not a list of
// independently proxyable commands, and prefixing any part of it would make the shell
// run a bogus command (`snip then echo y`, or `snip b)` inside a case arm). Requested
// in #27.
const COMPOUND_COMMAND_KEYWORDS = new Set([
  "for", "while", "until", "if", "case", "select", "function", "time", "{", "}", "!",
])

const UNPROXYABLE_COMMANDS = new Set([
  "cd", "source", ".", "export", "alias", "unset", "set", "shopt", "eval", "exec",
])

/**
 * Index just past the `$(...)` or `` `...` `` starting at `start`, whose body has its
 * own quoting context. Consuming it whole is what keeps the inner `"` of
 * `echo "$(printf "a;b")"` from being read as the end of the outer string, which would
 * expose the inner `;` as an operator. Unterminated input consumes the rest of the
 * string, which is the safe side.
 */
function skipSubstitution(command: string, start: number): number {
  if (command[start + 1] === "(") {
    let i = start + 2
    let depth = 1
    while (i < command.length) {
      const char = command[i]
      if (char === "\\") {
        i += 2
        continue
      }
      if (char === "'") {
        let j = i + 1
        while (j < command.length && command[j] !== "'") j++
        i = j + 1
        continue
      }
      if (char === '"') {
        let j = i + 1
        while (j < command.length && command[j] !== '"') {
          j += command[j] === "\\" ? 2 : 1
        }
        i = j + 1
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
  const end = command.indexOf("`", start + 1)
  return end === -1 ? command.length : end + 1
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
  let i = 0

  while (i < command.length) {
    const char = command[i]
    const next = command[i + 1]

    // Outside quotes a backslash escapes the next character, so `\'` is a literal
    // apostrophe rather than the start of a string, and `\`` is a literal backtick
    // rather than a command substitution. Without this the scanner enters a
    // single-quote state on `\'` and then reads every real separator as string text:
    // in `echo it\'s; ls` the `;` was not recognised and `ls` was never wrapped.
    // This also subsumes the double-quoted case, where the `"` in `echo "it\"s; fine"`
    // is part of the argument and must not end the string. Inside single quotes bash
    // honours no escapes, so the guard deliberately does not apply there.
    if (!inSingleQuote && char === "\\") {
      current += char + (next ?? "")
      i += 2
      continue
    }

    // A command substitution has its own quoting context, inside or outside quotes.
    // Inside single quotes it is literal, so it is deliberately not handled here.
    // Reached only for an unescaped `$(` or backtick: the guard above has already
    // consumed `\$(` and `` \` ``, which bash reads as literal text.
    if (!inSingleQuote && ((char === "$" && next === "(") || char === "`")) {
      const end = skipSubstitution(command, i)
      current += command.slice(i, end)
      i = end
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
      if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
        let op = ""
        while (current && /\s/.test(current[current.length - 1])) {
          op = current[current.length - 1] + op
          current = current.slice(0, -1)
        }
        op += char + next
        i += 2
        while (i < command.length && command[i] === " ") {
          op += " "
          i++
        }
        segments.push(current)
        segments.push(op)
        current = ""
        continue
      }

      // ; (semicolon)
      if (char === ";") {
        let op = ""
        while (current && /\s/.test(current[current.length - 1])) {
          op = current[current.length - 1] + op
          current = current.slice(0, -1)
        }
        op += ";"
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

function snipCommand(command: string): string {
  const envPrefix = (command.match(ENV_VAR_RE) ?? [""])[0]
  const bareCmd = command.slice(envPrefix.length).trim()
  if (!bareCmd) return command
  if (UNPROXYABLE_COMMANDS.has(bareCmd.split(/\s+/)[0])) return command
  return `${envPrefix}snip ${bareCmd}`
}

// True when any command segment opens a compound statement. Exempting only the
// keyword-led segment is not enough: in `case $f in a) echo one ;; b) echo two ;; esac`
// only the first segment starts with `case`, and the arm `b) echo two` would become
// `snip b) echo two`, which is a bash syntax error. So the whole command is left alone.
function isCompoundCommand(segments: string[]): boolean {
  return segments.some((segment, index) => {
    if (index % 2 === 1) return false
    const first = segment.trim().split(/\s+/)[0]
    return first !== undefined && COMPOUND_COMMAND_KEYWORDS.has(first)
  })
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