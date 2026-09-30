import { execFileSync } from "node:child_process"
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { toolExecuteBefore } from "./index"

const hasSnip = (() => {
  try {
    execFileSync("snip", ["--version"])
    return true
  } catch {
    return false
  }
})()

const SNIP_RUN = /^"[^"]*snip(\.exe)?" run -- /

describe.skipIf(!hasSnip)("toolExecuteBefore", () => {
  let mockInput: { tool: string; sessionID: string; callID: string }
  let mockOutput: { args: { command: string } }

  beforeEach(() => {
    mockInput = { tool: "bash", sessionID: "s", callID: "c" }
    mockOutput = { args: { command: "" } }
  })

  async function run(command: string) {
    mockOutput.args.command = command
    await toolExecuteBefore(mockInput, mockOutput)
    return mockOutput.args.command
  }

  it("should wrap a command snip has a filter for", async () => {
    const command = await run("git status")
    expect(command).toMatch(SNIP_RUN)
    expect(command).toMatch(/ run -- git status$/)
  })

  it("should keep env var prefixes before snip", async () => {
    expect(await run("CGO_ENABLED=0 go test ./...")).toMatch(/^CGO_ENABLED=0 "[^"]*" run -- go test \.\/\.\.\.$/)
  })

  it("should wrap each segment of a compound command", async () => {
    expect(await run("git status && git log -5")).toMatch(/ run -- git status && "[^"]*" run -- git log -5$/)
  })

  it("should not double wrap an already wrapped command", async () => {
    const wrapped = await run("git status")
    expect(await run(wrapped)).toBe(wrapped)
  })

  it("should not modify non-bash tool calls", async () => {
    mockInput.tool = "read"
    expect(await run("git status")).toBe("git status")
  })

  it.each([
    ["shell builtin", "cd /tmp"],
    ["command without filter", "echo hello"],
    ["head feeding a pipe", "git log | head"],
    ["head feeding a redirect", "go test ./... > out.txt"],
    ["command substitution", "git log $(git rev-parse HEAD)"],
    ["heredoc", "cat <<EOF\ngit status\nEOF"],
  ])("should leave %s untouched", async (_, command) => {
    expect(await run(command)).toBe(command)
  })

  describe("when snip is not reachable", () => {
    const path = process.env.PATH

    beforeEach(() => {
      process.env.PATH = ""
    })

    afterEach(() => {
      process.env.PATH = path
    })

    it("should leave the command untouched", async () => {
      expect(await run("git status")).toBe("git status")
    })
  })
})
