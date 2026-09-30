import { execFile } from "node:child_process"
import type { Hooks, Plugin } from "@opencode-ai/plugin"

// Delegates to `snip hook` (Claude Code PreToolUse format) so the rewrite rules
// stay in snip: only filtered commands are wrapped, pipes/redirects/heredocs and
// command substitutions are left raw. Any failure leaves the command untouched.
export function rewrite(command: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = execFile("snip", ["hook"], { timeout: 2000 }, (error, stdout) => {
      if (error || !stdout.trim()) return resolve(undefined)
      try {
        const rewritten = JSON.parse(stdout).hookSpecificOutput?.updatedInput?.command
        resolve(typeof rewritten === "string" ? rewritten : undefined)
      } catch {
        resolve(undefined)
      }
    })
    child.stdin?.on("error", () => {})
    child.stdin?.end(JSON.stringify({ tool_name: "Bash", tool_input: { command } }))
  })
}

export const toolExecuteBefore: NonNullable<Hooks["tool.execute.before"]> = async (input, output) => {
  if (input.tool !== "bash") return

  const command = output.args.command
  if (!command || typeof command !== "string") return

  const rewritten = await rewrite(command)
  if (rewritten) output.args.command = rewritten
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
