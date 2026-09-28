import { describe, it, expect, beforeEach } from "vitest"
import { toolExecuteBefore } from "./index"

describe("toolExecuteBefore", () => {
  let mockInput: { tool: string; sessionID: string; callID: string }
  let mockOutput: { args: { command: string } }

  beforeEach(() => {
    mockInput = { tool: "bash", sessionID: "s", callID: "c" }
    mockOutput = { args: { command: "" } }
  })

  it("should prefix simple command with snip", async () => {
    mockOutput.args.command = "go test ./..."
    await toolExecuteBefore(mockInput, mockOutput)
    expect(mockOutput.args.command).toBe("snip go test ./...")
  })

  it("should handle command with one env var prefix", async () => {
    mockOutput.args.command = "CGO_ENABLED=0 go test ./..."
    await toolExecuteBefore(mockInput, mockOutput)
    expect(mockOutput.args.command).toBe("CGO_ENABLED=0 snip go test ./...")
  })

  it("should handle command with multiple env var prefixes", async () => {
    mockOutput.args.command = "CGO_ENABLED=0 GOOS=linux go test ./..."
    await toolExecuteBefore(mockInput, mockOutput)
    expect(mockOutput.args.command).toBe("CGO_ENABLED=0 GOOS=linux snip go test ./...")
  })

  it("should handle command with &&", async () => {
    mockOutput.args.command = "go test && go build"
    await toolExecuteBefore(mockInput, mockOutput)
    expect(mockOutput.args.command).toBe("snip go test && snip go build")
  })

  it("should handle command with |", async () => {
    mockOutput.args.command = "git log | head"
    await toolExecuteBefore(mockInput, mockOutput)
    expect(mockOutput.args.command).toBe("snip git log | head")
  })

  it("should handle command with ;", async () => {
    mockOutput.args.command = "go test; go build"
    await toolExecuteBefore(mockInput, mockOutput)
    expect(mockOutput.args.command).toBe("snip go test; snip go build")
  })

  it("should handle command with ||", async () => {
    mockOutput.args.command = "test -f foo.txt || echo missing"
    await toolExecuteBefore(mockInput, mockOutput)
    expect(mockOutput.args.command).toBe("snip test -f foo.txt || snip echo missing")
  })

  it("should handle command with &", async () => {
    mockOutput.args.command = "sleep 1 & sleep 2 &"
    await toolExecuteBefore(mockInput, mockOutput)
    expect(mockOutput.args.command).toBe("snip sleep 1 & snip sleep 2 &")
  })

  it("should handle mixed operators", async () => {
    mockOutput.args.command = "go test && go build; go run"
    await toolExecuteBefore(mockInput, mockOutput)
    expect(mockOutput.args.command).toBe("snip go test && snip go build; snip go run")
  })

  it("should handle env vars with operators", async () => {
    mockOutput.args.command = "FOO=bar go test && go build"
    await toolExecuteBefore(mockInput, mockOutput)
    expect(mockOutput.args.command).toBe("FOO=bar snip go test && snip go build")
  })

  it("should not double prefix already prefixed command", async () => {
    mockOutput.args.command = "snip go test"
    await toolExecuteBefore(mockInput, mockOutput)
    expect(mockOutput.args.command).toBe("snip go test")
  })

  it("should not modify non-bash tool calls", async () => {
    mockInput.tool = "read"
    mockOutput.args.command = "go test"
    await toolExecuteBefore(mockInput, mockOutput)
    expect(mockOutput.args.command).toBe("go test")
  })

  describe("unproxyable shell builtins", () => {
    it("should skip cd", async () => {
      mockOutput.args.command = "cd /tmp"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("cd /tmp")
    })

    it("should skip source", async () => {
      mockOutput.args.command = "source ~/.bashrc"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("source ~/.bashrc")
    })

    it("should skip . (dot)", async () => {
      mockOutput.args.command = ". ./env.sh"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe(". ./env.sh")
    })

    it("should skip export", async () => {
      mockOutput.args.command = "export FOO=bar"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("export FOO=bar")
    })

    it("should skip alias", async () => {
      mockOutput.args.command = 'alias ll="ls -la"'
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe('alias ll="ls -la"')
    })

    it("should skip unset", async () => {
      mockOutput.args.command = "unset VAR"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("unset VAR")
    })

    it("should skip export with env var prefix", async () => {
      mockOutput.args.command = "CGO_ENABLED=0 export FOO=bar"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("CGO_ENABLED=0 export FOO=bar")
    })

    it("should skip cd but snip chained command", async () => {
      mockOutput.args.command = "cd /tmp && ls"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("cd /tmp && snip ls")
    })
  })

  describe("redirections with &", () => {
    it("should not break 2>&1 redirection", async () => {
      mockOutput.args.command = "find / -name \"*.log\" 2>&1"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("snip find / -name \"*.log\" 2>&1")
    })

    it("should not break 1>&2 redirection", async () => {
      mockOutput.args.command = "cmd 1>&2"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("snip cmd 1>&2")
    })

    it("should handle 2>&1 with pipe", async () => {
      mockOutput.args.command = "find / -name \"*.log\" 2>&1 | grep error"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("snip find / -name \"*.log\" 2>&1 | grep error")
    })

    it("should handle 2>&1 with chained commands", async () => {
      mockOutput.args.command = "cmd1 2>&1 && cmd2"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("snip cmd1 2>&1 && snip cmd2")
    })
  })

  describe("pipe expressions with quotes", () => {
    it("should not split pipes inside single quotes", async () => {
      mockOutput.args.command = "cat file.json | jq '.content | .text'"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("snip cat file.json | jq '.content | .text'")
    })

    it("should not split pipes inside double quotes", async () => {
      mockOutput.args.command = 'cat file.json | jq ".content | .text"'
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe('snip cat file.json | jq ".content | .text"')
    })

    it("should handle jq with fromjson", async () => {
      mockOutput.args.command = "cat file.json | jq '.content[0].text | fromjson'"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("snip cat file.json | jq '.content[0].text | fromjson'")
    })

    it("should handle multiple pipes in jq", async () => {
      mockOutput.args.command = "cat file.json | jq '.a | .b | .c'"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("snip cat file.json | jq '.a | .b | .c'")
    })

    it("should handle pipe with || operator", async () => {
      mockOutput.args.command = "cmd1 || cmd2"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("snip cmd1 || snip cmd2")
    })

    it("should handle mixed quotes and pipes", async () => {
      mockOutput.args.command = 'echo "hello | world" | cat'
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe('snip echo "hello | world" | cat')
    })
  })

  // Every assertion below used to fail by rewriting the command's own payload: a `snip`
  // landed inside a quoted argument, or the plugin tried to exec a shell keyword.

  describe("SSH and quoted remote commands", () => {
    it("should not split semicolons inside double-quoted SSH command", async () => {
      mockOutput.args.command = 'ssh root@host "echo hello; echo world"'
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe('snip ssh root@host "echo hello; echo world"')
    })

    it("should not split semicolons inside single-quoted SSH command", async () => {
      mockOutput.args.command = "ssh root@host 'echo hello; echo world'"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("snip ssh root@host 'echo hello; echo world'")
    })

    it("should not split && inside double-quoted SSH command", async () => {
      mockOutput.args.command = 'ssh root@host "cmd1 && cmd2"'
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe('snip ssh root@host "cmd1 && cmd2"')
    })

    it("should not split || inside double-quoted SSH command", async () => {
      mockOutput.args.command = 'ssh root@host "cmd1 || cmd2"'
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe('snip ssh root@host "cmd1 || cmd2"')
    })

    it("should not split multiple semicolons inside SSH command", async () => {
      mockOutput.args.command = 'ssh root@host "cmd1; cmd2; cmd3; cmd4"'
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe('snip ssh root@host "cmd1; cmd2; cmd3; cmd4"')
    })

    it("should still split operators outside quotes in SSH command", async () => {
      mockOutput.args.command = 'ssh root@host "echo hello; echo world" && echo done'
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe('snip ssh root@host "echo hello; echo world" && snip echo done')
    })

    it("should handle SSH with ssh options and quoted remote command", async () => {
      mockOutput.args.command = 'ssh -o BatchMode=yes root@host "hostname; uname -a"'
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe('snip ssh -o BatchMode=yes root@host "hostname; uname -a"')
    })

    it("should handle nested quotes in SSH command", async () => {
      mockOutput.args.command = 'ssh root@host "echo \'hello world\'; echo done"'
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe('snip ssh root@host "echo \'hello world\'; echo done"')
    })

    it("should handle docker exec with quoted command", async () => {
      mockOutput.args.command = 'docker exec container bash -c "cd /app && npm test"'
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe('snip docker exec container bash -c "cd /app && npm test"')
    })

    it("should handle bash -c with quoted command", async () => {
      mockOutput.args.command = 'bash -c "for i in 1 2 3; do echo $i; done"'
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe('snip bash -c "for i in 1 2 3; do echo $i; done"')
    })
  })

  describe("shell keywords", () => {
    it("should leave an if statement byte-identical", async () => {
      mockOutput.args.command = "if [ -f x ]; then echo y; fi"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("if [ -f x ]; then echo y; fi")
    })

    it("should leave a for loop byte-identical", async () => {
      mockOutput.args.command = "for i in a b; do cat $i; done"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("for i in a b; do cat $i; done")
    })

    // Exempting only the keyword-led segment leaves the arms proxied, and `snip b)`
    // is a bash syntax error.
    it("should leave a case statement byte-identical", async () => {
      mockOutput.args.command = "case $f in a) echo one ;; b) echo two ;; esac"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("case $f in a) echo one ;; b) echo two ;; esac")
    })

    it("should leave a multi-arm case statement byte-identical", async () => {
      mockOutput.args.command = "case $f in a) ls ;; b) cat f ;; c) echo c ;; esac"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("case $f in a) ls ;; b) cat f ;; c) echo c ;; esac")
    })

    it("should leave a multiline case statement byte-identical", async () => {
      mockOutput.args.command = "case $f in\na) echo one ;;\nesac\necho after"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("case $f in\na) echo one ;;\nesac\necho after")
    })

    it("should leave a for loop with a quoted variable byte-identical", async () => {
      mockOutput.args.command = 'for f in *.md; do echo "$f"; done'
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe('for f in *.md; do echo "$f"; done')
    })
  })

  describe("escapes and nested substitutions", () => {
    it("should not treat an escaped quote as the end of a double-quoted string", async () => {
      mockOutput.args.command = 'echo "it\\"s; fine"; echo after'
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe('snip echo "it\\"s; fine"; snip echo after')
    })

    it("should not inject after an escaped quote", async () => {
      mockOutput.args.command = 'echo "a\\"b; rm -rf /tmp/x"'
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe('snip echo "a\\"b; rm -rf /tmp/x"')
    })

    it("should still recognise an operator after an escaped quote", async () => {
      mockOutput.args.command = 'echo "a\\"b" && printf ok'
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe('snip echo "a\\"b" && snip printf ok')
    })

    it("should not split inside a substitution nested in double quotes", async () => {
      mockOutput.args.command = 'echo "$(printf "a;b")"'
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe('snip echo "$(printf "a;b")"')
    })

    it("should not split inside a backtick substitution in double quotes", async () => {
      mockOutput.args.command = 'echo "`printf a;b`"'
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe('snip echo "`printf a;b`"')
    })

    it("should not split inside an unquoted substitution", async () => {
      mockOutput.args.command = 'echo $(printf "a;b")'
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe('snip echo $(printf "a;b")')
    })
  })

  // Escapes OUTSIDE quotes. Every expectation below was measured against bash 5.x,
  // which is the authority for what a backslash does:
  //
  //   echo it\'s        -> it's            (a literal apostrophe, not a string)
  //   echo a\;b         -> a;b             (a literal semicolon, not an operator)
  //   echo a \| cat     -> a | cat         (a literal pipe, not an operator)
  //   echo \`date\`     -> `date`          (literal backticks, not a substitution)
  //
  // Regression on this branch: the splitter read `\'` as opening a single-quoted
  // string, so every real separator after it was swallowed as string text.
  describe("escapes outside quotes", () => {
    // The four tests below witness the regression: each fails on the pre-fix commit
    // of this branch. They all PASS against unmodified upstream main, because main
    // splits on a regex and never looks at quotes, so it is accidentally right here.
    // They therefore prove the fix, not by themselves the regression: the regression
    // is shown by pre-fix #30 differing from main, not by a failure on main.
    it("should recognise a semicolon after an escaped apostrophe", async () => {
      mockOutput.args.command = "echo it\\'s; ls"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("snip echo it\\'s; snip ls")
    })

    it("should recognise && after an escaped apostrophe", async () => {
      mockOutput.args.command = "echo it\\'s && ls"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("snip echo it\\'s && snip ls")
    })

    it("should recognise || after an escaped apostrophe", async () => {
      mockOutput.args.command = "echo it\\'s || ls"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("snip echo it\\'s || snip ls")
    })

    it("should recognise a background & after an escaped apostrophe", async () => {
      mockOutput.args.command = "echo it\\'s & ls"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("snip echo it\\'s & snip ls")
    })

    // PRE-EXISTING, not a regression: main is equally broken, because its regex
    // splits on the `;` inside `a\;` and injects `snip` into the argument. bash
    // reads `\;` as a literal semicolon, so `snip echo a\;snip b` made bash print
    // `a;snip b` - measured, not inferred. These tests therefore CANNOT witness a
    // regression, and are not claimed to.
    it("should not treat an escaped semicolon as an operator", async () => {
      mockOutput.args.command = "echo a\\;b"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("snip echo a\\;b")
    })

    it("should still split on a real semicolon after an escaped one", async () => {
      mockOutput.args.command = "echo a\\;b; echo second"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("snip echo a\\;b; snip echo second")
    })

    it("should not treat an escaped pipe as a pipeline", async () => {
      mockOutput.args.command = "echo a \\| cat"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("snip echo a \\| cat")
    })

    // Controls. These pass before and after the fix; they are here to prove the
    // guard did not over-reach and change behaviour that was already correct.
    it("should leave an escaped backtick pair as literal text", async () => {
      mockOutput.args.command = "echo \\`date\\`; ls"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("snip echo \\`date\\`; snip ls")
    })

    it("should not read an escaped $ as a command substitution", async () => {
      mockOutput.args.command = "echo \\$(date); ls"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("snip echo \\$(date); snip ls")
    })

    // Inside single quotes bash honours no escapes, so the `'` after `\` DOES close
    // the string and the `;` that follows is a real separator.
    it("should still close a single-quoted string at a backslash-quote", async () => {
      mockOutput.args.command = "echo 'a\\'; echo second"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("snip echo 'a\\'; snip echo second")
    })

    // `\\` is one escaped backslash, so the `'` that follows it is a real quote and
    // opens a string that bash never closes: the rest of the command is payload.
    // Leaving it un-split is the safe side, and matches bash refusing the input.
    //
    // Not a regression either: this passed before the fix as well, because pre-fix
    // #30 mis-read `\'` as a quote but read `\\` correctly. It is a control, and it
    // fails against main, which splits here - main is the wrong side on this input.
    it("should not open a string from a quote preceded by an escaped backslash", async () => {
      mockOutput.args.command = "echo a\\\\'; ls"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("snip echo a\\\\'; ls")
    })

    it("should still prefix only the head of a pipeline after an escaped apostrophe", async () => {
      mockOutput.args.command = "echo it\\'s | cat"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("snip echo it\\'s | cat")
    })
  })

  // A `NAME=value` prefix is read as shell words, not as `NAME=[^\s]* +`. The old
  // pattern could not cross a space, so it stopped inside a quoted or substituted
  // value and the `snip` was injected into that value.
  //
  // These are pre-existing bugs, not a regression: upstream main has the same
  // `ENV_VAR_RE` and is equally wrong on every case below, so a failure there is
  // evidence about main, not about this branch.
  describe("env var prefix values (fixes #22)", () => {
    it("should not inject inside a double-quoted value", async () => {
      mockOutput.args.command = 'FOO="a b" ls'
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe('FOO="a b" snip ls')
    })

    it("should not inject inside a single-quoted value", async () => {
      mockOutput.args.command = "MSG='hello world' ls"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("MSG='hello world' snip ls")
    })

    it("should not inject inside a command substitution value", async () => {
      mockOutput.args.command = "VAR1=$(echo hello) command"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("VAR1=$(echo hello) snip command")
    })

    it("should not inject inside a backtick substitution value", async () => {
      mockOutput.args.command = "V=$(printf `ls`) cmd"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("V=$(printf `ls`) snip cmd")
    })

    // The value is read by a later command, so a wrong value is observed as output.
    it("should not inject inside a value consumed by a later command", async () => {
      mockOutput.args.command = "FOO=\"a b\" bash -c 'echo V=$FOO'"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("FOO=\"a b\" snip bash -c 'echo V=$FOO'")
    })

    // Measured against bash: `ARR=(a b c)` is a three-element array. The old prefix
    // stopped at the first space, giving `ARR=(a snip b c)` — four elements. Merely
    // not splitting at the `(` is not enough either: that yields `snip ARR=(a b c)`,
    // which bash rejects with a syntax error, so the parens are counted.
    it("should keep an array assignment at three elements", async () => {
      mockOutput.args.command = "ARR=(a b c)"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("ARR=(a b c)")
    })

    it("should keep an array assignment intact before a command", async () => {
      mockOutput.args.command = "ARR=(a b c) ls -la"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("ARR=(a b c) snip ls -la")
    })

    // A bare assignment is not a command. `snip FOO=bar` reads as running `snip` with
    // FOO set and no arguments.
    it("should leave a bare assignment alone", async () => {
      mockOutput.args.command = "FOO=bar"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("FOO=bar")
    })

    it("should still keep a plain multi-assignment prefix", async () => {
      mockOutput.args.command = "A=1 B=2 ls"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("A=1 B=2 snip ls")
    })
  })

  // A heredoc body is literal text the command writes, not a list of commands. No
  // operator is recognised inside it and no text is rewritten.
  //
  // No upstream issue covers this. Unlike the two fixes above, this corrupts a FILE:
  // `cat <<'EOF' > conf` with `key = a; b` in the body wrote `key = a; snip b` to
  // disk and still exited 0, so the failure is silent and survives into the next run.
  describe("heredoc bodies (no upstream issue)", () => {
    it("should not rewrite a heredoc body", async () => {
      mockOutput.args.command = "cat <<EOF > conf\nkey = a; b\nEOF"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("snip cat <<EOF > conf\nkey = a; b\nEOF")
    })

    it("should not rewrite a single-quoted heredoc body", async () => {
      mockOutput.args.command = "cat <<'EOF' > conf\nline one; line two\nEOF"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("snip cat <<'EOF' > conf\nline one; line two\nEOF")
    })

    it("should not rewrite a double-quoted heredoc body", async () => {
      mockOutput.args.command = 'cat <<"EOF" > conf\nline one; line two\nEOF'
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe('snip cat <<"EOF" > conf\nline one; line two\nEOF')
    })

    it("should not rewrite a tab-stripped heredoc body", async () => {
      mockOutput.args.command = "cat <<-EOF\n\ta; b\nEOF"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("snip cat <<-EOF\n\ta; b\nEOF")
    })

    it("should not rewrite an unterminated heredoc", async () => {
      mockOutput.args.command = "cat <<EOF\na; b"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("snip cat <<EOF\na; b")
    })

    // `<<\EOF` is delimited by `EOF`: measured against bash, the terminator line never
    // carries the escaping backslash. An escaped delimiter stored verbatim looks
    // unterminated and swallows the rest of the command.
    it("should unescape an unquoted heredoc delimiter", async () => {
      mockOutput.args.command = "cat <<\\EOF\na; b\nEOF"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("snip cat <<\\EOF\na; b\nEOF")
    })

    // Inside quotes a backslash before an ordinary character is literal, so this one
    // really is delimited by `E\OF` and must NOT be unescaped.
    it("should keep a quoted escaped delimiter verbatim", async () => {
      mockOutput.args.command = "cat <<'E\\OF'\na; b\nE\\OF"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("snip cat <<'E\\OF'\na; b\nE\\OF")
    })

    // CANNOT witness the fix: unchanged by it, and unchanged on main too. The `;` is
    // inside a single-quoted string, so no implementation splits on it. Kept as a
    // control that a body containing a quote is still handled as payload.
    it("should not rewrite a heredoc body containing a quote", async () => {
      mockOutput.args.command = "python3 - <<'PY'\nimport os\nprint('a; b')\nPY"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("snip python3 - <<'PY'\nimport os\nprint('a; b')\nPY")
    })

    // Control, unchanged by the fix: `<<<` is a here-string, and its quoted content
    // was already inert.
    it("should not treat a here-string as a heredoc", async () => {
      mockOutput.args.command = "cat <<< 'a; b'"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("snip cat <<< 'a; b'")
    })

    // Control, unchanged by the fix and identical on main: `<<` inside `(( ))` is a
    // left shift. Armed as a heredoc it would swallow the rest of the command.
    it("should not treat a shift inside (( )) as a heredoc", async () => {
      mockOutput.args.command = "((x=1<<4))"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("snip ((x=1<<4))")
    })
  })

  // A `#` at the start of a word begins a comment, which runs to the end of its line
  // and contains no quotes.
  //
  // NOT a regression, and worth being precise about what this buys. main is identical,
  // because neither implementation treats a newline as an operator. On the SAME line,
  // the `; rm -rf …` is already part of the comment and the pre-existing scanner did
  // not split it either — what it did instead was inject `snip` into the comment text.
  // What the apostrophe case actually costs is the NEXT line: the `'` opens a string
  // that never closes, so every operator after it is swallowed. Note that the line
  // itself still is not wrapped, because a newline is not a segment boundary here.
  describe("comments", () => {
    it("should not split inside a comment", async () => {
      mockOutput.args.command = "ls -la # note; still a comment"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("snip ls -la # note; still a comment")
    })

    // The old output rewrote the comment text itself: `snip echo a # note; echo b`
    // became `snip echo a # note; snip echo b`. That `snip` is inert - it is comment
    // text, and bash runs only `snip echo a` either way - so nothing is lost and no
    // command goes missing. The fault is that the plugin rewrote text it was told not
    // to touch, and the emitted command no longer matches what was written.
    it("should not inject into a comment", async () => {
      mockOutput.args.command = "echo a # note; echo b"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("snip echo a # note; echo b")
    })

    // The real cost of the phantom string: the `;` on the following line was swallowed
    // and `echo after` was never filtered.
    //
    // It fails before the fix and passes on main, because main's regex never looks at
    // quotes and so is accidentally right here. It proves the fix; it is not by itself
    // evidence of a regression, which no test on main can be.
    it("should not let an apostrophe in a comment swallow the next line", async () => {
      mockOutput.args.command = "ls # don't delete\nls -la; echo after"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("snip ls # don't delete\nls -la; snip echo after")
    })

    it("should not let a comment starting the command swallow the next line", async () => {
      mockOutput.args.command = "# ls -la; rm f\nls -la; echo after"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("snip # ls -la; rm f\nls -la; snip echo after")
    })

    // Controls, unchanged by the fix and identical on main. A `#` mid-word is not a
    // comment, and a quoted one is text.
    it("should not treat a mid-word hash as a comment", async () => {
      mockOutput.args.command = "echo a#b; echo after"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("snip echo a#b; snip echo after")
    })

    it("should not treat a quoted hash as a comment", async () => {
      mockOutput.args.command = "grep '#' f; echo c"
      await toolExecuteBefore(mockInput, mockOutput)
      expect(mockOutput.args.command).toBe("snip grep '#' f; snip echo c")
    })
  })
})