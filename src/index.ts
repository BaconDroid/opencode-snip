import type { Hooks, Plugin } from "@opencode-ai/plugin"

const ENV_VAR_RE = /^([A-Za-z_][A-Za-z0-9_]*=[^\s]* +)*/
// Shell reserved words that open or close a compound statement; a segment starting with
// one is not a command at all. Requested in #27.
const SHELL_KEYWORDS = new Set([
  "if", "then", "elif", "else", "fi", "for", "while", "until", "do", "done",
  "case", "esac", "in", "function", "select", "time", "coproc",
  "{", "}", "[[", "]]", "!",
])

const UNPROXYABLE_COMMANDS = new Set([
  "cd", "source", ".", "export", "alias", "unset", "set", "shopt", "eval", "exec",
  ...SHELL_KEYWORDS,
])

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