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
  })
})