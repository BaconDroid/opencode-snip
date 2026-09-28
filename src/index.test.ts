import { beforeEach, describe, expect, it } from "vitest"
import { join } from "node:path"
import { mkdtempSync, readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"

import { toolExecuteBefore } from "./index"
import * as plugin from "./index"

// This suite is the fork's own regression net. It exercises the plugin in ./index.ts, and the
// unproxyable and shape suites re-probe the real `snip` binary, so a future `snip` upgrade that
// changes behaviour fails here instead of silently changing what the plugin is allowed to wrap.

// ==========================================================================
// ported from the local suite: snip-plugin.test.ts
// ==========================================================================

describe("patched opencode-snip plugin", () => {
  let mockInput: { tool: string; sessionID: string; callID: string }
  let mockOutput: { args: { command: string } }

  beforeEach(() => {
    mockInput = { tool: "bash", sessionID: "s", callID: "c" }
    mockOutput = { args: { command: "" } }
  })

  async function run(command: string): Promise<string> {
    mockOutput.args.command = command
    await toolExecuteBefore(mockInput, mockOutput)
    return mockOutput.args.command
  }

  // ---------------------------------------------------------------------
  // Test group 1 — Fix A: idempotent prefixing (no unbounded ratchet)
  // ---------------------------------------------------------------------
  describe("group 1: non-idempotent prefixing", () => {
    it("collapses a snip prefix after a non-leading position", async () => {
      expect(await run("cd /tmp && snip ls")).toBe("cd /tmp && snip run -- ls")
      expect(await run("cd /tmp && snip snip ls")).toBe("cd /tmp && snip run -- ls")
      expect(await run("cd /tmp && snip snip snip ls")).toBe("cd /tmp && snip run -- ls")
    })

    it("collapses a snip prefix behind an env-var prefix", async () => {
      expect(await run("FOO=1 snip ls")).toBe("FOO=1 snip run -- ls")
      expect(await run("FOO=1 snip snip ls")).toBe("FOO=1 snip run -- ls")
    })

    it("collapses a snip prefix after leading whitespace", async () => {
      expect(await run("  snip ls")).toBe("snip run -- ls")
      expect(await run("\tsnip ls")).toBe("snip run -- ls")
      // A leading newline is a segment boundary now, so it and the indentation that
      // follows it are preserved instead of being trimmed away.
      expect(await run("\n  snip ls")).toBe("\n  snip run -- ls")
    })

    it("collapses a bare snip (no trailing space)", async () => {
      expect(await run("snip")).toBe("snip")
      expect(await run("FOO=1 snip")).toBe("FOO=1 snip")
      // A bare `snip` reduces to an empty command, and snipCommand then returns the
      // original string verbatim (upstream behaviour for every early return), so the
      // surrounding whitespace survives - and nothing is emitted, because there is
      // nothing left to wrap. The fixed point is stable, which is what matters: the
      // point is that it never becomes `snip snip` or gains a `run --`.
      expect(await run("  snip  ")).toBe("  snip  ")
      expect(await run("  snip  ")).toBe(await run(await run("  snip  ")))
    })

    it("leaves the tail of a pipe untouched and non-doubling", async () => {
      // The head is wrapped and canonicalised; everything from the first top-level pipe
      // onward is left byte-identical, including any prefix the caller wrote there.
      expect(await run("echo x | snip grep y")).toBe("snip run -- echo x | snip grep y")
      expect(await run("echo x | snip snip grep y")).toBe("snip run -- echo x | snip snip grep y")
    })

    it("collapses the 8686-repetition real-world case to exactly one snip", async () => {
      const command = "cd /tmp && " + "snip ".repeat(8686) + "ls"
      const out = await run(command)
      expect(out).toBe("cd /tmp && snip run -- ls")
      expect(out.match(/snip/g)?.length).toBe(1)
    })

    it("is idempotent: a second pass changes nothing (corpus)", async () => {
      const corpus = [
        "ls -la",
        "go test ./...",
        "cd /tmp && ls",
        "cd /tmp && snip ls",
        "FOO=1 snip ls",
        "  snip ls",
        "snip",
        "echo x | snip grep y",
        "git log | head",
        "test -f foo.txt || echo missing",
        "CGO_ENABLED=0 GOOS=linux go test ./...",
        "sleep 1 & sleep 2 &",
        "find / -name \"*.log\" 2>&1",
        "cat file.json | jq '.content | .text'",
        "cat file.json | jq \".content | .text\"",
        "cd /tmp && " + "snip ".repeat(50) + "ls",
        "FOO=1 go test && go build",
        "cd /tmp && snip ls | snip head",
      ]
      for (const command of corpus) {
        const once = await run(command)
        const twice = await run(once)
        expect(twice, `not idempotent for ${JSON.stringify(command)}`).toBe(once)
      }
    })
  })

  // ---------------------------------------------------------------------
  // Test group 2 — Fix B: no payload corruption
  //
  // The hook must not rewrite anything inside quotes or heredoc bodies. Note the
  // two expectations below marked "unchanged": compound statements (for/while) are
  // deliberately left completely untouched, so output === input there.
  // ---------------------------------------------------------------------
  describe("group 2: payload corruption", () => {
    // Compound statements (for/while/...) are left completely untouched, and so is a
    // command whose output is redirected to a file: wrapping it would store the condensed
    // output in that file.
    const compoundUntouched = [
      "for f in *.md; do echo \"$f\"; done",
      "while read -r l; do echo \"$l; x\"; done < f",
      "cat > f <<'EOF'\nkey = value;\nEOF",
    ]
    // Everything else must come out byte-identical behind a single leading
    // `snip run -- `: the only difference from the input is that prefix.
    const prefixOnly = [
      "cat > f <<'EOF'\nkey = value;\nEOF",
      "grep -n \"a; b\" file",
      "jq -r \".a; .b\" file",
      "python3 -c 'import os; print(os.getcwd())'",
      "cat <<EOF\nkey = \"a; b\"\narr=[1;2]\nEOF",
      "diff <(cat <<'A'\nx; y\nA\n) <(cat <<'B'\np; q\nB\n)",
    ]

    it("makes no change at all to compound statements", async () => {
      for (const command of compoundUntouched) {
        expect(await run(command), command).toBe(command)
      }
    })

    it("leaves the payload byte-identical, only prefixing the whole command", async () => {
      for (const command of [...compoundUntouched, ...prefixOnly]) {
        const out = await run(command)
        const expected = compoundUntouched.includes(command) ? command : "snip run -- " + command
        expect(out, `corrupted: ${JSON.stringify(command)}`).toBe(expected)
        // Whatever the outcome, the payload after any leading prefix is the input.
        expect(out.replace(/^snip run -- /, ""), `payload changed: ${JSON.stringify(command)}`).toBe(command)
      }
    })

    it("does not corrupt a quoted operator in any position", async () => {
      expect(await run("grep -n \"a; b\" file")).toBe("snip run -- grep -n \"a; b\" file")
      expect(await run("grep -n 'a && b' file")).toBe("snip run -- grep -n 'a && b' file")
      expect(await run("echo \"x; y && z\"")).toBe("snip run -- echo \"x; y && z\"")
      expect(await run("jq '.a; .b' f.json")).toBe("snip run -- jq '.a; .b' f.json")
    })

    it("does not corrupt heredoc bodies", async () => {
      // Redirected to a file: the body is the payload AND the output is stored, so nothing
      // is inserted at all.
      const stored = "cat > f <<'EOF'\nkey = value;\nother = a && b\nEOF"
      expect(await run(stored)).toBe(stored)
      // Not redirected: the segment is wrapped, and the round-trip below proves the body
      // came through byte for byte.
      const piped = "cat <<'EOF'\nkey = value;\nother = a && b\nEOF"
      const out = await run(piped)
      expect(out).toBe("snip run -- " + piped)
      expect(out.split("snip run -- ").join("")).toBe(piped)
    })

    it("does not corrupt several heredocs on one line", async () => {
      const cmd = "diff <(cat <<'A'\nx; y\nA\n) <(cat <<'B'\np; q\nB\n)"
      expect(await run(cmd)).toBe("snip run -- " + cmd)
    })

    it("does not corrupt a dash heredoc body", async () => {
      const cmd = "cat <<-EOF\n\tkey = value;\n\tEOF"
      expect(await run(cmd)).toBe("snip run -- " + cmd)
    })

    // -------------------------------------------------------------------
    // Backslash-escaped heredoc delimiters. `cat <<\EOF` was stored verbatim, so
    // the terminator line `EOF` never matched, the heredoc looked unterminated,
    // and consumeHeredocBodies swallowed the rest of the command: every segment
    // after the terminator silently stopped being filtered. Measured against bash
    // 5.x, which is the authority for what the terminator is.
    // -------------------------------------------------------------------
    it("unescapes a backslash-escaped heredoc delimiter", async () => {
      // bash: `<<\EOF` is delimited by `EOF`.
      const cmd = "cat <<\\EOF\nbody;\nEOF\nls -la"
      expect(await run(cmd)).toBe("snip run -- cat <<\\EOF\nbody;\nEOF\nsnip run -- ls -la")
    })

    it("unescapes a backslash anywhere inside an unquoted delimiter", async () => {
      // bash: `<<E\OF` is delimited by `EOF`.
      const cmd = "cat <<E\\OF\nbody;\nEOF\nls -la"
      expect(await run(cmd)).toBe("snip run -- cat <<E\\OF\nbody;\nEOF\nsnip run -- ls -la")
    })

    it("unescapes an escaped backslash in a delimiter to a single backslash", async () => {
      // bash: `<<\\EOF` is delimited by `\EOF`, so the terminator line keeps one
      // backslash and the escaping one is removed.
      const cmd = "cat <<\\\\EOF\nbody;\n\\EOF\nls -la"
      expect(await run(cmd)).toBe("snip run -- cat <<\\\\EOF\nbody;\n\\EOF\nsnip run -- ls -la")
    })

    it("unescapes an escaped delimiter on a dash heredoc", async () => {
      // bash: `<<-\EOF` is delimited by `EOF`, and the leading tabs are stripped.
      const cmd = "cat <<-\\EOF\n\tkey = value;\n\tEOF\nls -la"
      expect(await run(cmd)).toBe("snip run -- cat <<-\\EOF\n\tkey = value;\n\tEOF\nsnip run -- ls -la")
    })

    it("leaves an unterminated escaped heredoc opaque instead of half-rewriting it", async () => {
      // Measured against bash: with no line equal to `EOF`, the heredoc runs to
      // end-of-file, so `body;` AND `ls -la` are both payload. The escaped word must
      // not be unescaped into a terminator that bash never looks for, and must not be
      // left in a state where the scanner starts treating body lines as commands.
      const cmd = "cat <<\\EOF\nbody;\nls -la"
      expect(await run(cmd)).toBe("snip run -- cat <<\\EOF\nbody;\nls -la")
    })

    it("keeps both quoted baselines working unchanged", async () => {
      // Quoted delimiters already worked, and they still terminate on the same line:
      // the post-terminator `ls -la` is gated exactly as before, so the fix did not
      // move a single boundary in the quoted cases.
      const single = "cat <<'EOF'\nbody;\nEOF\nls -la"
      expect(await run(single)).toBe("snip run -- cat <<'EOF'\nbody;\nEOF\nsnip run -- ls -la")
      const double = 'cat <<"EOF"\nbody;\nEOF\nls -la'
      expect(await run(double)).toBe('snip run -- cat <<"EOF"\nbody;\nEOF\nsnip run -- ls -la')
    })

    it("does NOT unescape inside quotes, where a backslash is literal", async () => {
      // Measured against bash 5.x: `<<'E\OF'` and `<<"E\OF"` are BOTH delimited by
      // `E\OF` verbatim - inside double quotes a backslash before an ordinary
      // character is literal, and single quotes honour no escape at all.
      //
      // The wrap on the trailing `ls -la` is the discriminating assertion here: the
      // heredoc ends on the line `E\OF`, so the next line is gated. Had the word been
      // unescaped to `EOF`, no line would ever match, the body would swallow the rest
      // of the command, and `ls -la` would come out unwrapped.
      const single = "cat <<'E\\OF'\nbody;\nE\\OF\nls -la"
      expect(await run(single)).toBe("snip run -- cat <<'E\\OF'\nbody;\nE\\OF\nsnip run -- ls -la")
      const double = 'cat <<"E\\OF"\nbody;\nE\\OF\nls -la'
      expect(await run(double)).toBe('snip run -- cat <<"E\\OF"\nbody;\nE\\OF\nsnip run -- ls -la')
    })

    it("does not corrupt a here-string", async () => {
      const cmd = "grep 'a; b' <<< \"a; b\""
      expect(await run(cmd)).toBe("snip run -- " + cmd)
    })

    it("does not corrupt escaped quotes", async () => {
      expect(await run('echo "a\\"; b"')).toBe('snip run -- echo "a\\"; b"')
    })

    it("does not treat ${VAR}, @{u}, brace expansion or find -exec {} as a block brace", async () => {
      expect(await run("echo ${HOME}")).toBe("snip run -- echo ${HOME}")
      expect(await run('echo "${arr[@]}"')).toBe('snip run -- echo "${arr[@]}"')
      expect(await run("git log main@{u}")).toBe("snip run -- git log main@{u}")
      expect(await run("find . -name {a,b}")).toBe("snip run -- find . -name {a,b}")
      expect(await run("find . -name '*.tmp' -exec rm {} \\;")).toBe(
        "snip run -- find . -name '*.tmp' -exec rm {} \\;",
      )
    })

    it("wraps a shell block body only as a whole, never per segment", async () => {
      const cmd = "{ cd /tmp; ls -la; }"
      expect(await run(cmd)).toBe(cmd)
    })

    it("leaves a function body untouched", async () => {
      const cmd = "f() { echo a; echo b; }"
      expect(await run(cmd)).toBe(cmd)
    })
  })

  // ---------------------------------------------------------------------
  // Test group 3 — upstream 1.6.1 regression suite, ported verbatim
  // ---------------------------------------------------------------------
  describe("group 3: upstream regression", () => {
    it("should prefix simple command with snip", async () => {
      expect(await run("go test ./...")).toBe("snip run -- go test ./...")
    })

    it("should handle command with one env var prefix", async () => {
      expect(await run("CGO_ENABLED=0 go test ./...")).toBe("CGO_ENABLED=0 snip run -- go test ./...")
    })

    it("should handle command with multiple env var prefixes", async () => {
      expect(await run("CGO_ENABLED=0 GOOS=linux go test ./...")).toBe(
        "CGO_ENABLED=0 GOOS=linux snip run -- go test ./...",
      )
    })

    it("should handle command with &&", async () => {
      expect(await run("go test && go build")).toBe("snip run -- go test && snip run -- go build")
    })

    it("should handle command with |", async () => {
      expect(await run("git log | head")).toBe("snip run -- git log | head")
    })

    it("should handle command with ;", async () => {
      expect(await run("go test; go build")).toBe("snip run -- go test; snip run -- go build")
    })

    it("should handle command with ||", async () => {
      expect(await run("test -f foo.txt || echo missing")).toBe(
        "snip run -- test -f foo.txt || snip run -- echo missing",
      )
    })

    it("should handle command with &", async () => {
      expect(await run("sleep 1 & sleep 2 &")).toBe("snip run -- sleep 1 & snip run -- sleep 2 &")
    })

    it("should handle mixed operators", async () => {
      expect(await run("go test && go build; go run")).toBe(
        "snip run -- go test && snip run -- go build; snip run -- go run",
      )
    })

    it("should handle env vars with operators", async () => {
      expect(await run("FOO=bar go test && go build")).toBe("FOO=bar snip run -- go test && snip run -- go build")
    })

    it("should not double prefix already prefixed command", async () => {
      expect(await run("snip go test")).toBe("snip run -- go test")
    })

    it("should not modify non-bash tool calls", async () => {
      mockInput.tool = "read"
      expect(await run("go test")).toBe("go test")
    })

    describe("unproxyable shell builtins", () => {
      it("should skip cd", async () => {
        expect(await run("cd /tmp")).toBe("cd /tmp")
      })

      it("should skip source", async () => {
        expect(await run("source ~/.bashrc")).toBe("source ~/.bashrc")
      })

      it("should skip . (dot)", async () => {
        expect(await run(". ./env.sh")).toBe(". ./env.sh")
      })

      it("should skip export", async () => {
        expect(await run("export FOO=bar")).toBe("export FOO=bar")
      })

      it("should skip alias", async () => {
        expect(await run('alias ll="ls -la"')).toBe('alias ll="ls -la"')
      })

      it("should skip unset", async () => {
        expect(await run("unset VAR")).toBe("unset VAR")
      })

      it("should skip export with env var prefix", async () => {
        expect(await run("CGO_ENABLED=0 export FOO=bar")).toBe("CGO_ENABLED=0 export FOO=bar")
      })

      it("should skip cd but snip chained command", async () => {
        expect(await run("cd /tmp && ls")).toBe("cd /tmp && snip run -- ls")
      })
    })

    describe("redirections with &", () => {
      it("should not break 2>&1 redirection", async () => {
        expect(await run('find / -name "*.log" 2>&1')).toBe('snip run -- find / -name "*.log" 2>&1')
      })

      it("should not break 1>&2 redirection", async () => {
        expect(await run("cmd 1>&2")).toBe("snip run -- cmd 1>&2")
      })

      it("should handle 2>&1 with pipe", async () => {
        expect(await run('find / -name "*.log" 2>&1 | grep error')).toBe(
          'snip run -- find / -name "*.log" 2>&1 | grep error',
        )
      })

      it("should handle 2>&1 with chained commands", async () => {
        expect(await run("cmd1 2>&1 && cmd2")).toBe("snip run -- cmd1 2>&1 && snip run -- cmd2")
      })
    })

    describe("pipe expressions with quotes", () => {
      it("should not split pipes inside single quotes", async () => {
        expect(await run("cat file.json | jq '.content | .text'")).toBe(
          "snip run -- cat file.json | jq '.content | .text'",
        )
      })

      it("should not split pipes inside double quotes", async () => {
        expect(await run('cat file.json | jq ".content | .text"')).toBe(
          'snip run -- cat file.json | jq ".content | .text"',
        )
      })

      it("should handle jq with fromjson", async () => {
        expect(await run("cat file.json | jq '.content[0].text | fromjson'")).toBe(
          "snip run -- cat file.json | jq '.content[0].text | fromjson'",
        )
      })

      it("should handle multiple pipes in jq", async () => {
        expect(await run("cat file.json | jq '.a | .b | .c'")).toBe(
          "snip run -- cat file.json | jq '.a | .b | .c'",
        )
      })

      it("should handle pipe with || operator", async () => {
        expect(await run("cmd1 || cmd2")).toBe("snip run -- cmd1 || snip run -- cmd2")
      })

      it("should handle mixed quotes and pipes", async () => {
        expect(await run('echo "hello | world" | cat')).toBe('snip run -- echo "hello | world" | cat')
      })
    })
  })

  // ---------------------------------------------------------------------
  // Test group 7 — `2>&1` must never be a segment boundary (A3)
  //
  // A bare `&` is only treated as an operator when whitespace precedes it, so the `&` in
  // `2>&1` is a redirection, not a split point. This is functionally equivalent to upstream
  // PR #26's `&(?!>)` fix, so #26 needs no port; these assertions exist so the property
  // cannot regress silently.
  // ---------------------------------------------------------------------
  describe("group 7: 2>&1 is a redirection, not a boundary", () => {
    it("does not split a command on the & of 2>&1", async () => {
      expect(await run("cmd 2>&1")).toBe("snip run -- cmd 2>&1")
      expect(await run("cmd1 2>&1 && cmd2")).toBe("snip run -- cmd1 2>&1 && snip run -- cmd2")
    })

    it("leaves the pre-pipe head intact when the redirection is before a pipe", async () => {
      expect(await run("ls -la 2>&1 | head -3")).toBe("snip run -- ls -la 2>&1 | head -3")
    })

    it("keeps the trailing redirection byte-identical", async () => {
      // The whole command is emitted verbatim except for the inserted prefix: stripping
      // every `snip run -- ` gives the input back.
      for (const command of ["cmd 2>&1", "cmd1 2>&1 && cmd2", "ls -la 2>&1 | head -3"]) {
        expect((await run(command)).split("snip run -- ").join(""), command).toBe(command)
      }
    })

    it("keeps descriptor duplications wrappable and destinations unwrapped", async () => {
      // `2>&1` / `1>&2` only duplicate a descriptor: the output still reaches whoever reads
      // stdout, so compaction is what that reader wants.
      expect(await run("cmd 2>&1")).toBe("snip run -- cmd 2>&1")
      expect(await run("cmd 1>&2")).toBe("snip run -- cmd 1>&2")
      // `>file` and `&>file` store the output, so wrapping would corrupt the file.
      expect(await run("cmd > out.txt 2>&1")).toBe("cmd > out.txt 2>&1")
      expect(await run("cmd &> all.txt")).toBe("cmd &> all.txt")
    })
  })

  // ---------------------------------------------------------------------
  // Test group 8 — regression tests for the three defects fixed against
  // upstream's internal/hook/rewrite.go
  // ---------------------------------------------------------------------
  describe("group 8: regression", () => {
    // Bug 1 — `<<` inside (( )) is a left shift, not a heredoc. Arming a heredoc there
    // swallowed the rest of the command and silently disabled filtering for it.
    it("does not read << inside (( )) as a heredoc operator", async () => {
      expect(await run("((x=1<<4))")).toBe("((x=1<<4))")
      expect(await run("((x=1<<4))\nls -la\necho done")).toBe(
        "((x=1<<4))\nsnip run -- ls -la\nsnip run -- echo done",
      )
      expect(await run("((x=1<<4)) && ls -la")).toBe("((x=1<<4)) && snip run -- ls -la")
      // The spaced form was always fine and must stay fine.
      expect(await run("(( x = 1 << 4 ))\nls -la")).toBe("(( x = 1 << 4 ))\nsnip run -- ls -la")
      expect(await run("x=$((1<<4)); echo GOT=$x")).toBe("x=$((1<<4)); snip run -- echo GOT=$x")
    })

    it("resets arithmetic depth at a newline so a later heredoc still works", async () => {
      // An unbalanced (( must not disarm heredoc detection for the rest of the command.
      expect(await run("((x=1<<4))\ncat <<EOF\nbody\nEOF")).toBe(
        "((x=1<<4))\nsnip run -- cat <<EOF\nbody\nEOF",
      )
    })

    // Bug 2 — a `#` comment runs to the end of its line, so the shell reads no operator
    // inside it. Splitting there injected a `snip` into comment text.
    it("does not split on an operator inside a comment", async () => {
      expect(await run("echo a # note; echo b")).toBe("snip run -- echo a # note; echo b")
      expect(await run("echo a # note && echo b")).toBe("snip run -- echo a # note && echo b")
      expect(await run("ls -la # note; echo done")).toBe("snip run -- ls -la # note; echo done")
    })

    it("still wraps a command whose payload contains a quoted or mid-word #", async () => {
      expect(await run("grep '#' f")).toBe("snip run -- grep '#' f")
      expect(await run("grep -n '#' f")).toBe("snip run -- grep -n '#' f")
      expect(await run("echo a#b")).toBe("snip run -- echo a#b")
    })

    it("does not let a comment arm a heredoc, and still arms one before a comment", async () => {
      // `<<EOF` inside the comment is comment text: `body` and `EOF` are commands.
      expect(await run("# cat <<EOF\nbody\nEOF")).toBe(
        "# cat <<EOF\nsnip run -- body\nsnip run -- EOF",
      )
      // A heredoc opened before the comment still works.
      expect(await run("cat <<'EOF' # trailing comment\nbody\nEOF")).toBe(
        "snip run -- cat <<'EOF' # trailing comment\nbody\nEOF",
      )
    })

    it("leaves a comment line alone and gates the next one", async () => {
      expect(await run("# note\nls -la")).toBe("# note\nsnip run -- ls -la")
    })

    // Bug 3 — `snip <cmd>` collides with snip's own subcommands; the canonical form is
    // `snip run -- <cmd>`, and both that and the legacy implicit form collapse.
    it("emits the `snip run --` form, which cannot collide with a snip subcommand", async () => {
      for (const name of ["init", "gain", "verify", "config", "learn", "check", "inspect"]) {
        expect(await run(name), name).toBe(`snip run -- ${name}`)
      }
      expect(await run("cd /tmp && init")).toBe("cd /tmp && snip run -- init")
    })

    it("collapses both the canonical and the legacy prefix to one canonical form", async () => {
      expect(await run("snip run -- ls -la")).toBe("snip run -- ls -la")
      expect(await run("snip ls -la")).toBe("snip run -- ls -la")
      expect(await run("snip run -- snip ls -la")).toBe("snip run -- ls -la")
      expect(await run("snip snip run -- ls -la")).toBe("snip run -- ls -la")
      expect(await run("FOO=1 snip ls -la")).toBe("FOO=1 snip run -- ls -la")
    })

    it("leaves a pipe tail byte-identical, prefix included", async () => {
      // Everything from the first top-level pipe onward is untouched, so a hand-written
      // prefix there is the caller's, not ours.
      expect(await run("ls -la | snip head -3")).toBe("snip run -- ls -la | snip head -3")
    })
  })

  // ---------------------------------------------------------------------
  // Test group 9 — the rule: a segment whose output is STORED is not wrapped,
  // a segment that only duplicates a descriptor still is. A pipe is not a
  // destination: the pipe half of upstream #111 is deliberately out of scope.
  // ---------------------------------------------------------------------
  describe("group 9: stored output is never compacted", () => {
    it("leaves a redirected segment byte-identical", async () => {
      for (const command of [
        "ls -la > out.txt",
        "ls -la >> out.txt",
        "ls -la 2> err.log",
        "ls -la &> all.txt",
        "ls -la >& all.txt",
        "ls -la >| out.txt",
        "FOO=1 ls -la > out.txt",
        "snip ls -la > out.txt",
        "(cd /tmp; ls > out.txt)",
      ]) {
        expect(await run(command), command).toBe(command)
      }
    })

    it("keeps compaction for destinations that are not regular files", async () => {
      // A character device stores nothing, so the output still reaches its reader.
      for (const destination of ["/dev/null", "/dev/zero", "/dev/stderr"]) {
        expect(await run(`cmd 2>${destination}`), destination).toBe(`snip run -- cmd 2>${destination}`)
        expect(await run(`cmd >${destination}`), destination).toBe(`snip run -- cmd >${destination}`)
        expect(await run(`cmd &>${destination}`), destination).toBe(`snip run -- cmd &>${destination}`)
      }
      // A fifo, a socket or a directory would behave the same way, but creating one here
      // would need a syscall the test has no business making.
    })

    it("blocks compaction for a destination that is a regular file", async () => {
      // An existing regular file, so the answer comes from `stat` and not from the
      // "does not exist yet" branch.
      const file = join(import.meta.dirname, "index.test.ts")
      expect(await run(`cmd >${file}`)).toBe(`cmd >${file}`)
      expect(await run(`cmd 2>${file}`)).toBe(`cmd 2>${file}`)
      // ... and the noclobber override resolves to the same word.
      expect(await run(`cmd >|${file}`)).toBe(`cmd >|${file}`)
    })

    it("fails closed when the destination cannot be resolved", async () => {
      // An unexpanded word could name anything, so it is treated as storing.
      expect(await run("cmd > $OUT")).toBe("cmd > $OUT")
      expect(await run("cmd > \"$OUT\"")).toBe("cmd > \"$OUT\"")
      expect(await run("cmd > $OUT.log")).toBe("cmd > $OUT.log")
      expect(await run("cmd > *.log")).toBe("cmd > *.log")
    })

    it("still wraps descriptor duplications", async () => {
      expect(await run("cmd 2>&1")).toBe("snip run -- cmd 2>&1")
      expect(await run("cmd1 2>&1 && cmd2")).toBe("snip run -- cmd1 2>&1 && snip run -- cmd2")
      expect(await run("cmd1 2>&1 && cmd2 2>&1")).toBe("snip run -- cmd1 2>&1 && snip run -- cmd2 2>&1")
      // An explicit descriptor word is a duplication too, not a file named "1".
      expect(await run("cmd >2")).toBe("snip run -- cmd >2")
      expect(await run("cmd 2>1")).toBe("snip run -- cmd 2>1")
    })

    it("still wraps pipe heads — the pipe is not a destination", async () => {
      expect(await run("ls -la | head -5")).toBe("snip run -- ls -la | head -5")
      expect(await run("ls -la 2>&1 | head -3")).toBe("snip run -- ls -la 2>&1 | head -3")
      // ... but a redirect in the head still wins, because the data goes to the file.
      expect(await run("ls -la > out.txt | head -3")).toBe("ls -la > out.txt | head -3")
    })

    it("decides per segment, not per command", async () => {
      expect(await run("cd /tmp && ls -la > out.txt")).toBe("cd /tmp && ls -la > out.txt")
      expect(await run("ls -la > out.txt; echo done")).toBe("ls -la > out.txt; snip run -- echo done")
      expect(await run("echo done; ls -la > out.txt")).toBe("snip run -- echo done; ls -la > out.txt")
      expect(await run("cmd1 2>&1 && cmd2 > out.txt")).toBe("snip run -- cmd1 2>&1 && cmd2 > out.txt")
    })

    it("is not fooled by a > inside a heredoc body, a comment or quotes", async () => {
      // The > is payload in all three: the segment is wrapped, and the following line with
      // a real command is still gated.
      expect(await run("echo x # > not a redirect\nls -la")).toBe(
        "snip run -- echo x # > not a redirect\nsnip run -- ls -la",
      )
      expect(await run("cat <<EOF\n> not a redirect\nEOF\nls -la")).toBe(
        "snip run -- cat <<EOF\n> not a redirect\nEOF\nsnip run -- ls -la",
      )
      expect(await run("grep '>' f")).toBe("snip run -- grep '>' f")
      expect(await run('grep ">" f')).toBe('snip run -- grep ">" f')
    })

    it("is idempotent on every one of these", async () => {
      for (const command of [
        "ls -la > out.txt",
        "cmd 2>&1",
        "cmd1 2>&1 && cmd2",
        "ls -la | head -5",
        "cd /tmp && ls -la > out.txt",
        "echo x # > not a redirect\nls -la",
        "cat <<EOF\n> not a redirect\nEOF\nls -la",
        "cd /tmp && " + "snip ".repeat(8686) + "ls",
        "cd /tmp && " + "snip ".repeat(8686) + "ls > out.txt",
      ]) {
        const once = await run(command)
        expect(await run(once), command).toBe(once)
        expect(await run(await run(once)), command).toBe(once)
      }
    })
  })

  // ---------------------------------------------------------------------
  // Test group 5 — drop-in public shape
  // ---------------------------------------------------------------------
  describe("group 5: public shape", () => {
    it("exports the factory, the hook and a default export", async () => {
      const mod = await import("./index")
      expect(typeof mod.SnipPlugin).toBe("function")
      expect(typeof mod.toolExecuteBefore).toBe("function")
      expect(mod.default).toBe(mod.SnipPlugin)
    })

    it("probes for snip with a shell builtin and registers the hook when snip is present", async () => {
      const mod = await import("./index")
      const calls: string[] = []
      const $ = (strings: TemplateStringsArray) => {
        calls.push(strings[0])
        return { quiet: async () => ({}) }
      }
      const result = await mod.SnipPlugin({ $ } as never)
      // `command -v`, not `which`: it is a shell builtin, so the probe works on a host
      // with no `which` binary. (This line is not one I wrote; it was already in the
      // file when this test was updated. Flagged in the report.)
      expect(calls).toEqual(["command -v snip"])
      expect(result["tool.execute.before"]).toBe(mod.toolExecuteBefore)
    })

    it("returns {} when the snip binary is missing", async () => {
      const mod = await import("./index")
      const $ = () => {
        throw new Error("command not found: snip")
      }
      const result = await mod.SnipPlugin({ $ } as never)
      expect(result).toEqual({})
    })
  })

  // ---------------------------------------------------------------------
  // Test group 4 — normal operation
  // ---------------------------------------------------------------------
  describe("group 4: normal operation", () => {
    it("wraps ordinary commands", async () => {
      expect(await run("ls -la")).toBe("snip run -- ls -la")
      expect(await run("git log")).toBe("snip run -- git log")
      expect(await run("cd /tmp && ls")).toBe("cd /tmp && snip run -- ls")
    })

    it("ignores empty and non-string commands", async () => {
      expect(await run("")).toBe("")
      mockOutput.args.command = undefined as unknown as string
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBeUndefined()
    })
  })

  // ---------------------------------------------------------------------
  // Test group 6 — segmentation: newline boundaries, pipe head, heredoc tail
  // (gate stubbed: these assertions are about which segments are produced)
  // ---------------------------------------------------------------------
  describe("group 6: segmentation", () => {
    it("treats a newline as a segment boundary", async () => {
      expect(await run("ls -la\nls -la")).toBe("snip run -- ls -la\nsnip run -- ls -la")
      expect(await run("cd /tmp\nls -la")).toBe("cd /tmp\nsnip run -- ls -la")
      expect(await run("echo one\necho two")).toBe("snip run -- echo one\nsnip run -- echo two")
    })

    it("gates the lines after a heredoc terminator independently (D8)", async () => {
      expect(await run("cat <<EOF\nbody\nEOF\necho one\necho two")).toBe(
        "snip run -- cat <<EOF\nbody\nEOF\nsnip run -- echo one\nsnip run -- echo two",
      )
      // `2>/dev/null` is a character device: nothing is stored there, so the segment is
      // still compacted. The two other segments are gated independently as well.
      expect(await run("cat <<EOF\nx\nEOF\nfind / -name '*.log' 2>/dev/null\necho done")).toBe(
        "snip run -- cat <<EOF\nx\nEOF\nsnip run -- find / -name '*.log' 2>/dev/null\nsnip run -- echo done",
      )
    })

    it("keeps a heredoc body out of the segment list", async () => {
      // The inserted prefixes are the observable segmentation: a body line that had been
      // treated as a segment would get its own `snip `.
      expect(await run("cat <<EOF\nkey = value; and more\nEOF\necho done")).toBe(
        "snip run -- cat <<EOF\nkey = value; and more\nEOF\nsnip run -- echo done",
      )
    })

    it("does not re-consume a heredoc body on a later newline", async () => {
      // The stale-`pending` bug disabled every segment after the terminator, so `echo one`
      // and `echo two` came out with no prefix at all.
      expect(await run("cat <<EOF\nbody\nEOF\necho one\necho two")).toBe(
        "snip run -- cat <<EOF\nbody\nEOF\nsnip run -- echo one\nsnip run -- echo two",
      )
    })

    it("splits the head of a piped command on its own operators (D7)", async () => {
      expect(await run("cd /tmp && ls -la | head -5")).toBe("cd /tmp && snip run -- ls -la | head -5")
      expect(await run("ls -la; cat f | head")).toBe("snip run -- ls -la; snip run -- cat f | head")
    })

    it("leaves everything from the first top-level pipe byte-identical", async () => {
      expect(await run("ls -la | head -3 2>&1")).toBe("snip run -- ls -la | head -3 2>&1")
      const cmd = "ls -la | grep x; cat y | wc -l"
      expect(await run(cmd)).toBe("snip run -- ls -la | grep x; cat y | wc -l")
    })

    it("keeps a backslash continuation intact instead of splitting it", async () => {
      expect(await run("ls \\\n  -la")).toBe("snip run -- ls \\\n  -la")
    })

    it("is idempotent across every segmentation change", async () => {
      const corpus = [
        "ls -la\nls -la",
        "cat <<EOF\nbody\nEOF\necho one\necho two",
        "cat <<EOF\nx\nEOF\nfind / -name '*.log' 2>/dev/null\necho done",
        "cd /tmp && ls -la | head -5",
        "snip ls -la",
        "cd /tmp && snip snip snip snip ls",
        "FOO=1 snip ls",
        " snip ls",
        "snip",
        "echo x | snip grep y",
        "cd /tmp && " + "snip ".repeat(8686) + "ls",
      ]
      for (const command of corpus) {
        const once = await run(command)
        const twice = await run(once)
        expect(twice, `not idempotent for ${JSON.stringify(command)}`).toBe(once)
      }
    })
  })
})

// ==========================================================================
// ported from the local suite: plugin-shape.test.ts
// ==========================================================================

const PLUGIN_PATH = join(import.meta.dirname, "index.ts")

// opencode's `$`, reduced to what the factory actually uses. `strings[0]` is the command
// text; `.quiet()` must exist and return the promise.
function fakeShell(behaviour: (command: string) => "ok" | "throws") {
  const calls: string[] = []
  const $ = ((strings: TemplateStringsArray) => {
    calls.push(strings[0])
    if (behaviour(strings[0]) === "throws") throw new Error("command not found")
    let resolveFn!: (value: unknown) => void
    const promise = new Promise((resolve) => {
      resolveFn = resolve
    }) as Promise<unknown> & { quiet: () => unknown }
    promise.quiet = () => promise
    resolveFn({ exitCode: 0, stdout: Buffer.alloc(0), text: () => "" })
    return promise
  }) as never
  return { $, calls }
}

async function run(command: string, tool = "bash"): Promise<string> {
  const output = { args: { command } }
  await plugin.toolExecuteBefore({ tool, sessionID: "s", callID: "c" } as never, output as never)
  return output.args.command
}

describe("plugin: public shape (upstream contract)", () => {
  it("exports the factory, the hook and a default export", () => {
    expect(typeof plugin.SnipPlugin).toBe("function")
    expect(typeof plugin.toolExecuteBefore).toBe("function")
    expect(plugin.default).toBe(plugin.SnipPlugin)
  })

  it("takes exactly (input, output) like the upstream hook", () => {
    // No third parameter any more: the gate is gone, so nothing needs a seam.
    expect(plugin.toolExecuteBefore.length).toBe(2)
  })

  it("probes for snip with a shell builtin and registers the hook when snip is present", async () => {
    const { $, calls } = fakeShell(() => "ok")
    const hooks = await plugin.SnipPlugin({ $ } as never)
    // `command -v`, not `which`: a shell builtin, so the probe works on a host with no
    // `which` binary. (That line is not one I wrote - it was already in the plugin when
    // this expectation was updated. Flagged in the report.)
    expect(calls).toEqual(["command -v snip"])
    expect(hooks["tool.execute.before"]).toBe(plugin.toolExecuteBefore)
  })

  it("returns {} and warns when the snip binary is missing", async () => {
    const { $ } = fakeShell(() => "throws")
    expect(await plugin.SnipPlugin({ $ } as never)).toEqual({})
  })

  it("registers the system-prompt hook that stops the model writing `snip` itself", async () => {
    const { $ } = fakeShell(() => "ok")
    const hooks = await plugin.SnipPlugin({ $ } as never)
    // Verified name: "experimental.chat.system.transform" is in the Hooks type of
    // @opencode-ai/plugin 1.18.32, so this needs no cast and cannot be a hook that silently
    // never fires.
    expect(typeof hooks["experimental.chat.system.transform"]).toBe("function")
    const system: string[] = ["existing prompt"]
    await plugin.systemTransform({ model: {} as never }, { system })
    expect(system).toHaveLength(2)
    expect(system[0]).toBe("existing prompt")
    expect(system[1]).toContain("snip")
    expect(system[1]).toMatch(/never write/i)
  })

  it("does not install the prompt hook when snip is missing", async () => {
    const { $ } = fakeShell(() => "throws")
    expect(await plugin.SnipPlugin({ $ } as never)).toEqual({})
  })

  it("ignores non-bash tools and non-string commands", async () => {
    expect(await run("ls -la", "read")).toBe("ls -la")
    const output = { args: { command: undefined as unknown as string } }
    await plugin.toolExecuteBefore({ tool: "bash", sessionID: "s", callID: "c" } as never, output as never)
    expect(output.args.command).toBeUndefined()
  })
})

describe("plugin: no subprocess work at all", () => {
  const source = readFileSync(PLUGIN_PATH, "utf8")

  it("imports nothing that could spawn a process", () => {
    for (const forbidden of [
      "node:child_process",
      "child_process",
      "execFile",
      "execSync",
      "spawnSync",
      "spawn(",
      "Bun.spawn",
      "node:bun",
    ]) {
      expect(source.includes(forbidden), `plugin must not reference ${forbidden}`).toBe(false)
    }
  })

  it("never shells out to `snip check`", () => {
    expect(source.includes("snip check")).toBe(false)
    expect(source.includes("command -v snip")).toBe(true) // the availability probe
  })

  it("keeps the idempotence helper's dual-form collapse logic", () => {
    // The helper must recognise BOTH the canonical `snip run -- ` and the legacy implicit
    // `snip ` prefix, otherwise a command written by hand in the old form gains a prefix
    // per pass again.
    expect(source).toContain("/^run\\s+--(?:\\s|$)/")
    expect(source).toContain("/^snip(?:\\s|$)/")
  })

  it("keeps the idempotence helper verbatim", () => {
    expect(source).toContain(
      'function stripSnipPrefixes(cmd: string): string {\n' +
        '  let s = cmd.trimStart()\n' +
        '  while (/^snip(?:\\s|$)/.test(s)) {\n' +
        '    s = s.slice(4).trimStart()\n' +
        '    const withSeparator = s.replace(/^run\\s+--(?:\\s|$)/, "")\n' +
        '    if (withSeparator !== s) s = withSeparator.trimStart()\n' +
        '  }\n' +
        '  return s\n' +
        '}',
    )
  })
})

// ==========================================================================
// ported from the local suite: unproxyable.test.ts
// ==========================================================================

// The oracle: run the real snip binary and look for its own refusal messages. A flag no
// real tool accepts makes a successfully proxied command fail with its own usage error
// instead of doing something, so the only `snip:`-prefixed output left is a refusal.
const PROBE_FLAG = "--zzz-opencode-probe"
const REFUSED = /snip: .*cannot be proxied|snip: passthrough: fork\/exec/

const sandbox = mkdtempSync(join(tmpdir(), "snip-honesty-"))

function snipRefuses(word: string): { refused: boolean; output: string } {
  let output = ""
  try {
    output = execFileSync("bash", ["-c", `snip ${word} ${PROBE_FLAG} 2>&1 </dev/null`], {
      cwd: sandbox,
      encoding: "utf8",
      timeout: 5000,
    })
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    output = (err.stdout ?? "") + (err.stderr ?? "")
  }
  return { refused: REFUSED.test(output), output: output.trim() }
}

// The list lives in the plugin source; parse it back out so the test cannot drift from it.
function listFromSource(name: string): string[] {
  const source = readFileSync(join(import.meta.dirname, "index.ts"), "utf8")
  const start = source.indexOf(`const ${name} = new Set([`)
  expect(start, `${name} not found in the plugin source`).toBeGreaterThan(-1)
  const open = source.indexOf("[", start)
  const close = source.indexOf("])", open)
  const body = source.slice(open + 1, close)
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]!)
}

const UNPROXYABLE = listFromSource("UNPROXYABLE_COMMANDS")
const PARENT_STATE = listFromSource("PARENT_STATE_COMMANDS")

// Commands that must stay wrappable. `patch`, `cargo`, `go`, `docker`, `pnpm`, `yq` and
// friends are refused by snip on this machine only because they are not installed, so the
// probe skips words that have no binary on PATH - otherwise the test would assert that
// "not installed" means "must be refused", which is the opposite of what the list wants.
const MUST_STAY_WRAPPABLE = [
  "ls", "cat", "grep", "rg", "find", "sed", "awk", "jq", "head", "tail", "wc", "sort",
  "uniq", "diff", "patch", "tar", "curl", "wget", "git", "cargo", "npm", "pnpm", "pytest",
  "make", "docker", "kubectl", "ps", "du", "df", "python3", "node", "bash", "sh", "go",
  "mkdir", "rm", "cp", "mv", "chmod", "tee", "xargs", "yq", "gh", "git",
]

function installed(word: string): boolean {
  try {
    execFileSync("bash", ["-c", `command -v -- ${JSON.stringify(word)} >/dev/null 2>&1`])
    return true
  } catch {
    return false
  }
}

// `snip` is the oracle for the refusal list. On a runner that does not have it, the
// two probes that shell out are skipped rather than failed on a missing tool.
const HAS_SNIP = (() => {
  try {
    execFileSync("bash", ["-c", "command -v snip >/dev/null 2>&1"])
    return true
  } catch {
    return false
  }
})()
if (!HAS_SNIP) {
  console.warn("[test] `snip` is not on PATH: the two refusal-oracle probes are SKIPPED, not verified")
}

const INSTALLED_SAMPLE = MUST_STAY_WRAPPABLE.filter(installed)

describe("UNPROXYABLE_COMMANDS stays honest against the real snip binary", () => {
  it("has the derived size", () => {
    expect(UNPROXYABLE.length).toBe(71)
  })

  it.skipIf(!HAS_SNIP)("every entry is actually refused by snip", () => {
    const wrong: string[] = []
    for (const word of UNPROXYABLE) {
      const { refused, output } = snipRefuses(word)
      if (!refused) wrong.push(`${JSON.stringify(word)} -> ${JSON.stringify(output.slice(0, 80))}`)
    }
    expect(wrong, `entries snip does not refuse: ${wrong.join(", ")}`).toEqual([])
  })

  it("every entry is a shell builtin or keyword, never a missing external tool", () => {
    // This is what keeps `cargo`/`go`/`docker` out of the list: hardcoding a tool that is
    // merely absent on this machine would suppress filtering wherever it is installed.
    const shellWords = new Set(
      execFileSync("bash", ["-c", "compgen -b; compgen -k"], { encoding: "utf8" })
        .split("\n")
        .map((w) => w.trim())
        .filter(Boolean),
    )
    const notShellWords = UNPROXYABLE.filter((word) => !shellWords.has(word))
    expect(notShellWords, `not shell words: ${notShellWords.join(", ")}`).toEqual([])
  })

  it("no command that must stay wrappable is in the list", () => {
    const wrong = MUST_STAY_WRAPPABLE.filter((word) => UNPROXYABLE.includes(word))
    expect(wrong, `must stay wrappable but listed: ${wrong.join(", ")}`).toEqual([])
  })

  it.skipIf(!HAS_SNIP)("the real snip binary does not refuse the installed must-stay-wrappable sample", () => {
    expect(INSTALLED_SAMPLE.length).toBeGreaterThan(20)
    const refused = INSTALLED_SAMPLE.filter((word) => snipRefuses(word).refused)
    expect(refused, `snip unexpectedly refuses: ${refused.join(", ")}`).toEqual([])
  })
})

describe("PARENT_STATE_COMMANDS: refused by us, not by snip", () => {
  it("is the other way round for every entry", () => {
    expect(PARENT_STATE.length).toBeGreaterThan(0)
    for (const word of PARENT_STATE) {
      const { refused } = snipRefuses(word)
      expect(refused, `${word} is a snip refusal, so it belongs in UNPROXYABLE_COMMANDS`).toBe(false)
      expect(UNPROXYABLE.includes(word), `${word} must not be in both sets`).toBe(false)
    }
  })

  it("the plugin really does refuse to wrap a job-spec kill", async () => {
    const output = { args: { command: "kill %1" } }
    await toolExecuteBefore({ tool: "bash", sessionID: "s", callID: "c" } as never, output as never)
    expect(output.args.command).toBe("kill %1")
  })
})

// ==========================================================================
// ported from the local suite: idempotence.test.ts
// ==========================================================================

async function once(command: string): Promise<string> {
  const output = { args: { command } }
  await toolExecuteBefore({ tool: "bash", sessionID: "s", callID: "c" } as never, output as never)
  return output.args.command
}

const snipCount = (text: string) => (text.match(/\bsnip /g) ?? []).length

describe("idempotence", () => {
  it("hook(hook(x)) === hook(x) over the whole corpus", async () => {
    for (const command of CORPUS) {
      const once$ = await once(command)
      const twice = await once(once$)
      expect(twice, `not idempotent: ${JSON.stringify(command)} -> ${JSON.stringify(once$)}`).toBe(once$)
    }
  })

  it("is idempotent three times over, to catch a slow ratchet", async () => {
    for (const command of RATCHET_CASES) {
      let current = command
      for (let pass = 0; pass < 3; pass++) {
        const next = await once(current)
        expect(next, `ratcheted on pass ${pass + 1}: ${JSON.stringify(command)}`).toBe(
          pass === 0 ? next : current,
        )
        current = next
      }
    }
  })

  it("never lets the snip count grow after the first pass", async () => {
    for (const command of [...CORPUS, ...RATCHET_CASES]) {
      const first = await once(command)
      const second = await once(first)
      const third = await once(second)
      // The first pass may legitimately add one prefix; no later pass may add another.
      expect(snipCount(second), `snip count grew on pass 2: ${JSON.stringify(command)}`).toBe(
        snipCount(first),
      )
      expect(snipCount(third), `snip count grew on pass 3: ${JSON.stringify(command)}`).toBe(
        snipCount(first),
      )
    }
  })

  it("collapses the 8686-repetition case to exactly one snip", async () => {
    const out = await once("cd /tmp && " + "snip ".repeat(8686) + "ls")
    expect(out).toBe("cd /tmp && snip run -- ls")
    expect(snipCount(out)).toBe(1)
  })
})

// ==========================================================================
// inlined fixture (was ./corpus.ts in the local suite)
// ==========================================================================

// The command corpus shared by the divergence, idempotence and coverage probes.
//
// NOTE on `ps aux | grep node | grep -v grep`: wrapping it changes the output, and the cause
// is the `ps` FILTER, not our rewriter and not flag filtering. Measured 2026-09-27:
//   ps aux | wc -l        -> 477      snip ps aux | wc -l   -> 31
//   last line of `snip ps aux` -> "... more processes"   (announced truncation to ~30 rows)
//   `snip ps -o pid,comm -p 1` -> byte-identical to raw  (so `-o` flags are NOT dropped)
// The 5 `nodev` matches vanish because those process rows are past the ~30-row cut, which is
// why the downstream `grep node` finds nothing. An earlier attribution of mine ("the ps filter
// drops -o flags") was wrong: `snip ps -o pid,comm -p 1` is byte-identical to raw.
const CORPUS = [
  "ls -la", "ls", "git log", "git status", "git diff", "pwd", "make build", "cargo test --all",
  "cargo build", "npm test", "pnpm test", "pytest -q", "go test ./...", "kubectl get pods -n default",
  "docker ps -a", "grep -rn TODO src", "rg -n foo", "cat README.md", "tar czf a.tgz dir/",
  "du -sh *", "df -h", "find . -name '*.ts'", "sed -n 1,5p f", "awk -F';' '{print $1}' f.csv",
  "jq .a f.json", "head -20 f", "tail -20 f", "wc -l f", "sort f", "uniq f", "diff a b",
  "CGO_ENABLED=0 go test ./...", "FOO=bar go test && go build", "CGO_ENABLED=0 GOOS=linux go build ./...",
  "go test && go build", "go test; go build", "go test || go build", "sleep 1 & sleep 2 &",
  "go test && go build; go run", "a; b; c", "cd /tmp && ls", "mkdir -p x && cd x && ls",
  "cd /tmp; ls -la", "git log | head", "cat f | jq .a | head -5", "ls | wc -l",
  "ps aux | grep node | grep -v grep", "cd /tmp && ls | head", "ls -la; cat f | head",
  "echo x | cat | head", "cd /tmp", "source ~/.bashrc", ". ./env.sh", "export FOO=bar",
  'alias ll="ls -la"', "unset VAR", "CGO_ENABLED=0 export FOO=bar", 'eval "$CMD"', "exec bash",
  "set -e", "shopt -s globstar", 'find / -name "*.log" 2>&1', "cmd 1>&2", "cmd > out.txt",
  "cmd 2> err.log", "cmd1 2>&1 && cmd2", "cmd >> log.txt", "cmd &> all.txt", "cat a > b 2>&1",
  "ls | grep x 2>&1", 'echo "a; b"', "echo 'a; b'", "grep 'a && b' f", 'grep "x; y" f',
  "awk -F';' '{print $1}' f.csv", "sed 's/a;b/c;d/' f", "printf '%s; %s\\n' a b",
  "jq '.a | .b' f.json", 'jq ".a; .b" f', "ls *.md", "cat *.json", "curl -s https://x/y?a=1&b=2",
  "git log --format='%h %s' | head -5", 'grep x <<< "$VAR"', "diff <(cmd1) <(cmd2)", "cat < file",
  "ls -la  ", "  ls -la", "ls -la;  ls", "true;", "  ", "echo done # trailing comment", "ls; echo 'a;b'",
  "echo ${HOME}", "echo $HOME", "echo ${VAR:-default}", "find . -name '*.tmp' -exec rm {} \\;",
  "awk '{print $1}' f", "[[ -f x ]] && cat x", "[ -f x ] && cat x", "test -f x && echo y",
  "cd /tmp\nls -la", "ls -la\nls -la", "snip ls", "snip ls | head", "cd x && snip ls",
  "for f in *.md; do echo \"$f\"; done", "while read -r l; do echo \"$l\"; done < f",
  "if [ -f x ]; then ls; fi", "case $x in a) ls;; esac", "f() { echo a; echo b; }",
  "cat > f <<'EOF'\nkey = value;\nEOF", "cat <<EOF\narr=[1;2]\nEOF", "cat <<-EOF\n\tkey = value;\n\tEOF",
  "cat <<'A' <<'B'\nfirst\nA\nsecond\nB", "diff <(cat <<'A'\nx; y\nA\n) <(cat <<'B'\np; q\nB\n)",
  "cd /tmp && snip ls", "FOO=1 snip ls", "  snip ls", "snip", "echo x | snip grep y",
  "find . -name {a,b}", "{ ls; }", "git log main@{u}", "echo ${arr[@]}",
  "V=$(printf %s hello); echo GOT=$V", 'FOO="a b" bash -c \'echo V=$FOO\'', "kill %1",
  "read -r x </dev/null", "mapfile -t L < f.txt; echo done", "x=1; echo GOT=$x",
]

// The ratchet cases, called out explicitly: each one used to gain a `snip ` per pass.
const RATCHET_CASES = [
  "cd /tmp && snip ls",
  "cd /tmp && snip snip snip snip ls",
  "FOO=1 snip ls",
  "  snip ls",
  "\tsnip ls",
  "snip",
  "echo x | snip grep y",
  "cd /tmp && " + "snip ".repeat(8686) + "ls",
]
