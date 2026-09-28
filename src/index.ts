import { statSync } from "node:fs"
import type { Hooks, Plugin } from "@opencode-ai/plugin"

const ENV_VAR_RE = /^([A-Za-z_][A-Za-z0-9_]*=[^\s]* +)*/

// ENV_VAR_RE is greedy: `[^\s]*` happily eats `$(printf` in `V=$(printf %s hello)` or
// `(a` in `ARR=(a b c)`, so the extracted "env prefix" can be shell syntax. Testing only
// the remainder is not enough: for `ARR=(a b c)` the remainder is `b c)`, whose first word
// `b` is a perfectly good command word. So the prefix itself has to look like a plain
// `NAME=value` assignment - an unquoted value with no shell metacharacter in it. Anything
// else (`FOO="a b" …`, `MSG='hello world' …`, `ARR=(a b c)`, `V=$(…)`) is not trusted as a
// prefix, and the segment is then judged as a whole, where the first word fails
// PROXYABLE_COMMAND_WORD. Cost: a quoted env prefix (`FOO="a b" ls`) is no longer filtered,
// which is the safe direction - it used to be corrupted.
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_.,:/~@%+-]*$/

// `snip` fork/execs its argv; it never re-parses through a shell. Only a simple command
// word can be prefixed. Anything else — `((`, `(`, `#`, `$(`, a backtick, `NAME=value`,
// `NAME=(...)`, a leading redirection — is shell syntax that would either break the parse
// or silently change the value.
const PROXYABLE_COMMAND_WORD = /^[A-Za-z0-9_~/.][A-Za-z0-9_~./*-]*(?=\s|$)/

// Command words that must never be prefixed, derived empirically from the real `snip`
// binary (snip 0.25.2). Two refusal classes end up here, and both are PATH-independent:
//
//   snip: read cannot be proxied (it must run in the parent shell to modify the environment)
//   snip: passthrough: fork/exec [[: no such file or directory
//
// The first is snip's explicit list. The second is a shell construct with no /usr/bin
// twin (`[[`, `{`, `dirs`, `times`, ...): snip tries to exec it, so a stray binary of that
// name on PATH would silently replace the builtin.
//
// What is deliberately NOT here: external tools that snip "refuses" only because they are
// not installed (`cargo`, `go`, `pnpm`, `docker`, `patch`, ... all report the fork/exec
// class on a machine where they are absent). Hardcoding those would gut filtering on any
// machine where they are present, so the derivation filters them out - they are not shell
// words. A sweep of ~130 external commands found none that snip refuses intrinsically.
//
// Regenerate with:
//   cd /tmp/opencode/snip-test && npx tsx derive-unproxyable2.ts
// It probes `compgen -b` + `compgen -k` with `snip <word> --zzz-opencode-probe`, keeps the
// words whose output matches /cannot be proxied/ (intrinsic) plus the shell words whose
// exec fails (no twin), and reports any external command refused intrinsically.
// unproxyable.test.ts re-runs the probe on every entry so this list cannot rot silently.
const UNPROXYABLE_COMMANDS = new Set([
  "!", ".", ":", "[[", "]]", "alias", "bg", "bind", "break", "builtin", "caller", "case", "cd",
  "compgen", "complete", "compopt", "continue", "coproc", "declare", "dirs", "disown", "do",
  "done", "elif", "else", "enable", "esac", "eval", "exec", "exit", "export", "fg", "fi", "for",
  "function", "getopts", "hash", "help", "history", "if", "in", "jobs", "let", "local",
  "logout", "mapfile", "popd", "pushd", "read", "readarray", "readonly", "return", "select",
  "set", "shift", "shopt", "source", "suspend", "then", "times", "trap", "typeset", "ulimit",
  "umask", "unalias", "unset", "until", "wait", "while", "{", "}",
])

// Words snip *does* run, but whose builtin form needs the parent shell, so a forked child
// is not equivalent. `kill %1` (job spec) fails under snip while working in the shell:
//   plain   rc=0 "KILLED"
//   snip    rc=1 "KILLED\nkill: cannot find process \"%1\""
// Kept separate from UNPROXYABLE_COMMANDS on purpose: these are NOT refusals, and
// unproxyable.test.ts asserts the opposite for them.
const PARENT_STATE_COMMANDS = new Set(["kill"])

// Keywords that open a *compound statement*. Prefixing any segment of such a statement
// would make bash execute a bogus command (`snip while read -r l`), so the whole command
// is left untouched. Every one of these is also in UNPROXYABLE_COMMANDS, so this guard is
// belt and braces: it keeps the command byte-identical instead of wrapping only the inner
// simple commands.
const COMPOUND_COMMAND_KEYWORDS = new Set([
  "for", "while", "until", "if", "case", "select", "function", "time", "{", "}", "!",
])

type Operator = { start: number; end: number }
type Heredoc = { delimiter: string; stripTabs: boolean }
type ScanResult = {
  pipeIndex: number
  operators: Operator[]
  redirects: Operator[]
  hasBlockBrace: boolean
}

function isSpace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r"
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9"
}

// A redirection word ends at the first character that cannot belong to a path: whitespace,
// a command separator, a redirection, a pipe or a subshell delimiter. The word is only used
// to decide whether a destination can store the output durably, so the shell's own quoting
// rules do not need to be reproduced exactly - a word containing a metacharacter is reported
// as unresolvable and fails closed.
function readWord(command: string, start: number): string {
  let i = start
  while (i < command.length) {
    const char = command[i]
    if (
      isSpace(char) ||
      char === ";" ||
      char === "|" ||
      char === "&" ||
      char === ">" ||
      char === "<" ||
      char === "(" ||
      char === ")"
    ) {
      break
    }
    i++
  }
  return command.slice(start, i)
}

/**
 * Whether a redirection destination stores the command output durably.
 *
 * Only a regular file does. Wrapping `ls > out.txt` makes the file hold the condensed
 * output instead of the tool's own bytes, and saves no token because those bytes never
 * reach the model. A character device (`/dev/null` above all), fifo, socket, directory or
 * any other non-file keeps no such record, so the output still reaches its reader and the
 * compaction is what that reader wants.
 *
 * A word that would need expansion cannot be resolved without running the shell, so it
 * fails closed (treated as storing), and so does one that does not exist yet: the shell
 * creates a missing redirection target as a regular file.
 *
 * Relative words are resolved against the agent process's cwd, which is not necessarily
 * the shell's. That can only err towards "storing" (a name that exists as a file here but
 * is a device in the shell's directory), which loses filtering but never corrupts a file.
 */
// The word a redirection operator points at, skipping the `>|` noclobber override that may
// sit between the operator and its target.
function destinationWord(command: string, afterOperator: number): string {
  const start = command[afterOperator] === "|" ? afterOperator + 1 : afterOperator
  return readWord(command, start)
}

function storesOutput(word: string): boolean {
  if (word === "") return true
  if (/[$`*?(){}[\]<>'"]/.test(word)) return true
  try {
    // `throwIfNoEntry: false` turns ENOENT into `undefined`; any other error (EACCES,
    // ELOOP, ENOTDIR, ENAMETOOLONG) still throws and is caught below.
    return statSync(word, { throwIfNoEntry: false })?.isFile() ?? true
  } catch {
    return true
  }
}

// A `#` only opens a comment when it starts a word: at the start of the command, or
// after whitespace or a command separator. `grep '#' f` and `echo a#b` are unaffected
// because the first is inside quotes and the second is mid-word.
function isWordStart(command: string, index: number): boolean {
  if (index === 0) return true
  const previous = command[index - 1]
  if (previous === undefined) return true
  return isSpace(previous) || previous === ";" || previous === "&" || previous === "|" || previous === "(" || previous === ")"
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

// Backslash quote removal for an UNQUOTED heredoc word. Measured against bash 5.x:
// `<<\EOF` is delimited by `EOF`, `<<E\OF` by `EOF`, and `<<\\EOF` by `\EOF` — the
// terminator line never carries the escaping backslash, and no other line does.
// Storing the word verbatim made every escaped delimiter look unterminated, which
// made consumeHeredocBodies swallow the rest of the command: the line after the
// terminator stopped being filtered at all, silently.
//
// Quoted words are deliberately NOT passed through this. Measured: `<<'E\OF'` and
// `<<"E\OF"` are both delimited by `E\OF` verbatim — inside double quotes a
// backslash before an ordinary character is literal — so the branches above, which
// return the slice unchanged, are already correct.
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

// `<<DELIM`, `<<-DELIM`, `<<'DELIM'`, `<<"DELIM"`. Returns the parsed heredoc and the
// index just past the delimiter word. `<<<` is a here-string, not a heredoc, and is
// rejected by the caller before this runs.
function readHeredoc(command: string, start: number): { heredoc: Heredoc; next: number } | null {
  let i = start + 2
  let stripTabs = false
  if (command[i] === "-") {
    stripTabs = true
    i++
  }
  const quote = command[i]
  if (quote === "'" || quote === '"') {
    const end = command.indexOf(quote, i + 1)
    if (end === -1) return null
    const delimiter = command.slice(i + 1, end)
    if (!delimiter) return null
    return { heredoc: { delimiter, stripTabs }, next: end + 1 }
  }
  let end = i
  while (end < command.length && !/[\s;|<>&()]/.test(command[end])) end++
  if (end === i) return null
  const delimiter = unescapeHeredocWord(command.slice(i, end))
  if (!delimiter) return null
  return { heredoc: { delimiter, stripTabs }, next: end }
}

// Heredoc bodies start on the line after the `<<DELIM` redirection and run to a line
// equal to the delimiter. Anything in between is payload: no operator is recognised
// there and no text is rewritten.
function consumeHeredocBodies(command: string, start: number, pending: Heredoc[]): number {
  if (pending.length === 0) return start
  let i = start
  for (const { delimiter, stripTabs } of pending) {
    let terminated = false
    while (i <= command.length) {
      let lineEnd = command.indexOf("\n", i)
      if (lineEnd === -1) lineEnd = command.length
      const line = command.slice(i, lineEnd)
      if ((stripTabs ? line.replace(/^\t+/, "") : line) === delimiter) {
        // Stop *on* the newline: it ends the heredoc redirection and is a real
        // segment boundary for whatever follows.
        i = lineEnd
        terminated = true
        break
      }
      i = lineEnd + 1
      if (lineEnd === command.length) break
    }
    // Unterminated heredoc: treat the remainder as opaque rather than rewriting it.
    if (!terminated || i > command.length) return command.length
  }
  // Bodies are consumed: drop the queue so a later newline cannot re-consume them.
  pending.length = 0
  return i
}

// Walks the command once, tracking quoting and heredoc state, and reports the top-level
// operator spans plus the index of the first top-level pipe. A newline outside quotes
// and heredoc bodies is a top-level boundary: each line of a multi-line agent command is
// an independent command and is decided on its own.
function scanTopLevel(command: string): ScanResult {
  const operators: Operator[] = []
  const redirects: Operator[] = []
  const pending: Heredoc[] = []
  let pipeIndex = -1
  let hasBlockBrace = false
  // Depth of unquoted `(`/`{` groupings. A newline inside one of them is whitespace
  // inside a compound command, not a statement separator, so it must not become a
  // segment boundary: `diff <(cat <<'A'\nx\nA\n) <(cat <<'B'\ny\nB\n)` is one command.
  let nesting = 0
  // Depth of unquoted `((`, where `<<` is a left shift and NOT a heredoc operator.
  // Arming a heredoc there swallows the rest of the command and silently disables
  // filtering for it: `((x=1<<4))\nls -la` used to arm a heredoc on delimiter "4",
  // fail to find it, and leave `ls -la` unwrapped. Command substitution is rejected
  // upstream, so `((` here can only be arithmetic. Reset at every newline so an
  // unbalanced `((` cannot disarm heredoc detection for the remainder.
  let arith = 0
  let i = 0

  while (i < command.length) {
    const char = command[i]

    if (char === "\n") {
      if (pending.length > 0) {
        // This newline closes the line that carried `<<DELIM`: swallow the bodies.
        i = consumeHeredocBodies(command, i + 1, pending)
        continue
      }
      if (nesting === 0) operators.push({ start: i, end: i + 1 })
      arith = 0
      i++
      continue
    }
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
    if (char === "#" && isWordStart(command, i)) {
      // A comment runs to the end of its line, so the shell reads no operator inside
      // it: a `;`, `&&`, `||` or `|` there is not a group boundary, and a `<<` there
      // does not open a heredoc. Splitting on them injected a `snip` into comment
      // text (`echo a # note; echo b` -> `echo a # note; snip echo b`). Stop on the
      // newline, not past it: the newline still separates this line from the next.
      const newline = command.indexOf("\n", i)
      i = newline === -1 ? command.length : newline
      continue
    }
    if (char === "<" && command[i + 1] === "<") {
      if (command[i + 2] === "<") {
        i += 3
        continue
      }
      if (arith === 0) {
        const read = readHeredoc(command, i)
        if (read) {
          pending.push(read.heredoc)
          i = read.next
          continue
        }
      }
      // `<<` inside (( )) is a left shift, and a malformed heredoc falls through to
      // being ordinary text.
      i += 2
      continue
    }
    if (char === "(") {
      if (command[i + 1] === "(") {
        arith++
        i += 2
        continue
      }
      nesting++
      i++
      continue
    }
    if (char === ")") {
      if (arith > 0 && command[i + 1] === ")") {
        arith--
        i += 2
        continue
      }
      if (nesting > 0) nesting--
      i++
      continue
    }
    if (char === "{" || char === "}") {
      // A block brace is whitespace-delimited: `{ ls; }`. This excludes `${var}`,
      // `${arr[@]}`, `main@{u}`, `{}` (as in `find -exec {} \;`) and brace
      // expansion such as `-name {a,b}`.
      const before = i > 0 && isSpace(command[i - 1])
      const after = isSpace(char === "{" ? command[i + 1] : command[i - 1])
      if (before && after) {
        hasBlockBrace = true
        if (char === "{") nesting++
        else if (nesting > 0) nesting--
      }
      i++
      continue
    }

    if (char === "|") {
      if (command[i + 1] === "|") {
        operators.push({ start: i, end: i + 2 })
        i += 2
        continue
      }
      if (pipeIndex === -1) pipeIndex = i
      i++
      continue
    }
    if (char === "&") {
      // `&>file` / `&>>file` sends BOTH streams to a destination. It is one operator, not a
      // split: treating it as a background `&` would put the head in its own segment and
      // the head would then be wrapped, storing the condensed output in the file.
      if (command[i + 1] === ">") {
        const end = i + (command[i + 2] === ">" ? 3 : 2)
        if (storesOutput(destinationWord(command, end))) redirects.push({ start: i, end })
        i = end
        continue
      }
      if (command[i + 1] === "&") {
        operators.push({ start: i, end: i + 2 })
        i += 2
        continue
      }
      // A bare `&` is only an operator when whitespace precedes it: in `2>&1` it is a
      // redirection and must not be split.
      if (i > 0 && isSpace(command[i - 1])) operators.push({ start: i, end: i + 1 })
      i++
      continue
    }
    if (char === ">") {
      // `2>&1` / `1>&2` / `>&2` only DUPLICATE a descriptor: the command's output still
      // reaches whoever reads stdout, so compaction is still what that reader wants and
      // nothing is stored. `>N` and `2>&N` are the same thing with an explicit target.
      // `>file`, `>>file`, `2>file`, `>&file`, `>|file` send a stream somewhere durable
      // instead - the stored bytes are then not what the tool would have written, and no
      // token is saved because they never reach the model. Measured on snip 0.25.2:
      // `ls -la > f` writes 275 bytes / 6 lines, `snip run -- ls -la > f` writes 80 bytes
      // / 4 lines (the `total` line and `.`/`..` are gone). A segment whose destination
      // stores the output is therefore emitted verbatim.
      if (isDigit(command[i + 1])) {
        i++ // the word is a file descriptor, not a path
        while (isDigit(command[i])) i++
        continue
      }
      if (command[i + 1] === "&" && isDigit(command[i + 2])) {
        i += 2 // descriptor duplication, not a destination
        while (isDigit(command[i])) i++
        continue
      }
      // The digits before `>` (`2>`) select the redirected descriptor, they are a prefix and
      // not part of the destination.
      let start = i
      while (start > 0 && isDigit(command[start - 1])) start--
      const end = command[i + 1] === ">" || command[i + 1] === "|" ? i + 2 : i + 1
      if (storesOutput(destinationWord(command, end))) redirects.push({ start, end })
      i = end
      continue
    }
    if (char === ";") {
      operators.push({ start: i, end: i + 1 })
      i++
      continue
    }
    i++
  }

  return { pipeIndex, operators, redirects, hasBlockBrace }
}

// Yields the trimmed command text of every top-level segment (the text between
// operators), preserving the surrounding whitespace of the original command.
function segmentCores(command: string, operators: Operator[]): string[] {
  const cores: string[] = []
  let cursor = 0
  for (const { start, end } of operators) {
    cores.push(command.slice(cursor, start).trim())
    cursor = end
  }
  cores.push(command.slice(cursor).trim())
  return cores
}

function isCompoundCommand(command: string, scan: ScanResult): boolean {
  if (scan.hasBlockBrace) return true
  return segmentCores(command, scan.operators).some((core) => {
    const first = core.split(/\s+/)[0]
    return first !== undefined && COMPOUND_COMMAND_KEYWORDS.has(first)
  })
}

type Segment = { before: string; core: string; after: string; op: string; coreStart: number; coreEnd: number }

// Splits the region [0, limit) into segments delimited by the given operator spans.
// `limit` lets the caller stop at a pipe so the tail can be re-emitted verbatim. Each
// segment records the absolute range of its core, which is what lets the caller ask
// "does this particular segment contain a redirect?" without re-scanning it.
function planSegments(command: string, spans: Operator[], limit = command.length): Segment[] {
  const segments: Segment[] = []
  let cursor = 0
  for (const { start, end } of [...spans, { start: limit, end: limit }]) {
    const region = command.slice(cursor, start)
    const coreStart = region.length - region.trimStart().length
    const coreEnd = region.trimEnd().length
    segments.push({
      before: region.slice(0, coreStart),
      core: region.slice(coreStart, coreEnd),
      after: region.slice(coreEnd),
      op: command.slice(start, end),
      coreStart: cursor + coreStart,
      coreEnd: cursor + coreEnd,
    })
    cursor = end
  }
  return segments
}

// A segment whose core contains a redirect to a destination is emitted verbatim: wrapping
// it would store the condensed output in that destination. A pipe is NOT a destination for
// this purpose - the pipe half of upstream #111 is deliberately out of scope, so pipe heads
// keep being wrapped.
function renderSegments(segments: Segment[], redirects: Operator[]): string {
  return segments
    .map((segment) => {
      const stored = redirects.some(
        (redirect) => redirect.start >= segment.coreStart && redirect.end <= segment.coreEnd,
      )
      return segment.before + snipCommand(segment.core, stored) + segment.after + segment.op
    })
    .join("")
}

// The prefix this plugin emits. `snip run -- <cmd>` rather than the implicit
// `snip <cmd>`: snip dispatches its own subcommands before it ever looks at a
// command, so the implicit form silently runs the wrong thing for 15 of its own
// subcommand names - measured on snip 0.25.2, `snip init` reports "snip init
// complete:" and `snip config` prints its config. Under `run --`, 12 of the 15
// correctly fall through to exec of the tool of that name; `init` and `trust`
// still collide (see the comment on SNIP_PREFIX below).
const SNIP_PREFIX = "snip run -- "

// Consumes every `snip` prefix this plugin can have emitted - the canonical
// `snip run -- ` and the legacy implicit `snip ` - so a command that arrives
// already wrapped is normalised to a single canonical form instead of gaining
// another prefix per pass. `snip run` without `--` is left alone: it is not a
// form this plugin emits, and treating it as the command named `run` is the
// conservative reading.
function stripSnipPrefixes(cmd: string): string {
  let s = cmd.trimStart()
  while (/^snip(?:\s|$)/.test(s)) {
    s = s.slice(4).trimStart()
    const withSeparator = s.replace(/^run\s+--(?:\s|$)/, "")
    if (withSeparator !== s) s = withSeparator.trimStart()
  }
  return s
}

/**
 * Returns the segment to emit: wrapped when its first word is a simple command word that
 * snip can actually proxy, otherwise the segment exactly as it came in. A rejected segment
 * is never rewritten - in particular an existing `snip ` prefix is not stripped away.
 *
 * `outputIsStored` is set when the segment redirects a stream to a file or another durable
 * destination: compaction would then write condensed bytes where the caller expects the
 * tool's own output, and no token is saved because those bytes never reach the model.
 */
function snipCommand(command: string, outputIsStored = false): string {
  if (outputIsStored) return command
  const candidate = (command.match(ENV_VAR_RE) ?? [""])[0]
  // Only trust the extracted prefix if every chunk really is a plain assignment.
  const chunks = candidate.trimEnd().split(/\s+/)
  const envPrefix = chunks.every((chunk) => ENV_ASSIGNMENT_RE.test(chunk)) ? candidate : ""
  const rest = command.slice(envPrefix.length).trim()
  if (!rest) return command
  const bareCmd = stripSnipPrefixes(rest)
  if (!bareCmd) return command
  const firstWord = bareCmd.split(/\s+/)[0]
  if (UNPROXYABLE_COMMANDS.has(firstWord)) return command
  if (PARENT_STATE_COMMANDS.has(firstWord)) return command
  if (!PROXYABLE_COMMAND_WORD.test(firstWord)) return command
  return `${envPrefix}${SNIP_PREFIX}${bareCmd}`
}

export const toolExecuteBefore: NonNullable<Hooks["tool.execute.before"]> = async (input, output) => {
  if (input.tool !== "bash") return

  const command = output.args.command
  if (!command || typeof command !== "string") return

  const scan = scanTopLevel(command)

  if (isCompoundCommand(command, scan)) return

  if (scan.pipeIndex !== -1) {
    // Everything from the first top-level pipe onward is left byte-identical (upstream
    // behaviour, and what the upstream suite asserts). The head is split on its own
    // operators first: `cd /tmp && ls | head` must still filter `ls`.
    const prePipe = scan.operators.filter((operator) => operator.start < scan.pipeIndex)
    const head = renderSegments(planSegments(command, prePipe, scan.pipeIndex), scan.redirects)
    output.args.command = head + command.slice(scan.pipeIndex)
    return
  }

  if (scan.operators.length === 0) {
    // Single segment: any redirect found by the scan is inside it, and a redirect inside a
    // quote, a comment or a heredoc body is never found at all.
    output.args.command = snipCommand(command, scan.redirects.length > 0)
    return
  }

  output.args.command = renderSegments(planSegments(command, scan.operators), scan.redirects)
}

/**
 * Attacks the *upstream cause* of the duplication bug rather than only its idempotence.
 *
 * Our production data showed the model writing the prefix itself: 99 of the stored commands
 * carried a model-authored `snip`. That is what fed the ratchet, because the original guard
 * only inspected offset 0 of the whole command (`if (command.startsWith("snip ")) return`), so
 * a prefix in any later segment, behind an env assignment, or after a newline was invisible to
 * it and every pass added one more - up to 8686 repetitions in one stored command.
 * `stripSnipPrefixes` makes the hook idempotent; telling the model not to write the prefix
 * removes the source.
 *
 * Hook name verified in the `Hooks` type of @opencode-ai/plugin 1.18.32, so no cast is needed.
 * If a future opencode drops this hook the guidance silently stops being injected, which is
 * harmless - unlike a hook that opencode never calls while the code pretends it does.
 */
const NO_MANUAL_SNIP = [
  "Command output is already filtered for you: the `bash` tool routes commands through `snip` automatically.",
  "Never write the `snip ` prefix yourself; it is added for you, and a hand-written prefix produces doubled prefixes.",
].join(" ")

export const systemTransform: NonNullable<Hooks["experimental.chat.system.transform"]> = async (
  _input,
  output,
) => {
  output.system.push(NO_MANUAL_SNIP)
}

export const SnipPlugin: Plugin = async ({ $ }) => {
  try {
    await $`command -v snip`.quiet()
  } catch {
    console.warn("[snip] snip binary not found in PATH — plugin disabled")
    return {}
  }

  return {
    "tool.execute.before": toolExecuteBefore,
    "experimental.chat.system.transform": systemTransform,
  }
}

export default SnipPlugin
