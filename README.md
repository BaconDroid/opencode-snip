# opencode-snip

OpenCode plugin that automatically prefixes shell commands with [snip](https://github.com/edouard-claude/snip) to reduce LLM token consumption by 60-90%.

## This fork

This is a fork of [VincentHardouin/opencode-snip](https://github.com/VincentHardouin/opencode-snip). It is consumed as `github:BaconDroid/opencode-snip`, and it diverges from upstream `main` by four commits, with nothing missing from upstream:

1. `455793d` — replaces `src/index.ts` with a quote-, comment- and heredoc-aware rewriter, and ports the regression suite into `src/index.test.ts` so the fork verifies itself.
2. `81d2790` — makes the inherited release workflow manual-only (`workflow_dispatch` instead of triggering on a successful CI run), so a `fix:` commit on the default branch cannot start publishing to npm.
3. `a0d4183` — corrects the divergence count in this file and names both content commits.
4. `2dcc4f9` — unescapes backslashes in an unquoted heredoc delimiter, so `cat <<\EOF` terminates on `EOF` as bash does instead of swallowing the rest of the command.

Everything else in the repository is upstream's, including `.opencode/plugins/index.ts`, which re-exports `../../src/index.ts` and is therefore unchanged.

### Why a fork, and what it is actually ahead of

`snip` already ships a command rewriter, and this fork is **at parity with it on scanning, not ahead of it.** Measured against [`edouard-claude/snip`](https://github.com/edouard-claude/snip) at tag `v0.25.2`, `internal/hook/` contains `rewrite.go` (392 l.), `blockscope.go` (500 l.), `parse.go` (180 l.), `quote.go` (79 l.), `transparent.go` (196 l.) and `suggest.go` (61 l.) — roughly 1 400 lines of scanner, plus roughly 2 100 lines of tests and a benchmark. Its header states that *cmd is split on top-level `;`, `&&`, `||`, `&` and newline boundaries (quoted regions and comments are respected)*, and it handles escaped-newline continuation, `((` arithmetic disambiguation, block and paren scope, and heredoc delimiter unquoting — the last of which this fork only just added for itself in `2dcc4f9`, against the same authority it used, bash.

That rewriter is mature, and **unreachable from opencode.** Its only entry point is `snip hook`, and every `snip init --agent` target is a `PreToolUse` stdin/stdout hook. opencode cannot provide that shape: it exposes an in-process `tool.execute.before` with a mutable `output` object, not a stdin/stdout filter. Bridging them would mean bolting a process pipe onto an in-process hook contract, so the plugin is the right bridge. **That incompatibility is the whole justification for this fork — the parsing quality is not.** What the fork is ahead of is the *upstream plugin*, which is a different artefact and a real regression.

Concretely, the upstream **plugin** splits a command on a regular expression and prefixes each piece, which both corrupted shell payloads and lost filtering opportunities. This fork tokenises the command instead — tracking quotes, comments, heredoc bodies, arithmetic, operators and redirections — and then decides per segment. The concrete problems it fixes: a `>` inside a heredoc body or a comment was mistaken for a redirection; `2>&1` and `&>` were mangled; only the first command of a pipeline was prefixed; and a command whose output was redirected to a **file** was prefixed anyway, so the file ended up holding the *condensed* output instead of the tool's own bytes (measured with snip 0.25.2: `ls -la > out.txt` writes 275 bytes including the `total` line, `snip run -- ls -la > out.txt` writes 80 bytes without it, and the tokens are saved nowhere because the file never reaches the model). A segment whose redirection target is a regular file is now emitted verbatim, while a descriptor duplication (`2>&1`) and a pipe are still compacted. It also skips arithmetic expansion and trailing comments as filterable payload, and keeps a ratchet on the 71-entry unproxyable list so it cannot drift away from what `snip` actually refuses.

These are the problems reported upstream in issues [#15](https://github.com/VincentHardouin/opencode-snip/issues/15), [#22](https://github.com/VincentHardouin/opencode-snip/issues/22) and [#23](https://github.com/VincentHardouin/opencode-snip/issues/23); the fixes belong upstream, and this fork exists so the behaviour can be corrected without waiting. No upstream code path is removed.

Validated against snip 0.25.2: `npm test` runs 112 tests and `npm run typecheck` is clean. The suite lives in `src/index.test.ts` and re-probes the real `snip` binary to prove the refusal list is still honest, so a future `snip` upgrade that changes behaviour fails loudly rather than silently. Two of those probes need the binary on `PATH` and are reported as skipped when it is absent.

## What is snip?

[snip](https://github.com/edouard-claude/snip) is a CLI proxy that filters shell output before it reaches your LLM context window.

| Command | Before | After | Savings |
|---------|--------|-------|---------|
| `go test ./...` | 689 tokens | 16 tokens | 97.7% |
| `git log` | 371 tokens | 53 tokens | 85.7% |
| `cargo test` | 591 tokens | 5 tokens | 99.2% |

## Installation

### 1. Install snip

```bash
brew install edouard-claude/tap/snip
# or
go install github.com/edouard-claude/snip/cmd/snip@latest
```

### 2. Configure OpenCode

Add the plugin to your OpenCode config (`~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-snip@latest"]
}
```

To use this fork instead, reference it without a version pin (the fix has to come from the default branch):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["github:BaconDroid/opencode-snip"]
}
```

## How It Works

The plugin uses the `tool.execute.before` hook to prefix all commands with `snip`. Commands that would not survive being prefixed — shell builtins such as `cd`, `export` or `shopt`, and any segment whose output is redirected to a file — are left exactly as written.

## Development

This package uses [semantic-release](https://semantic-release.gitbook.io/) for automated releases. Commit messages should follow the [Conventional Commits](https://www.conventionalcommits.org/) format:

- `fix:` → patch release
- `feat:` → minor release
- `feat!:`, `fix!:` → major release

`npm test` runs the suite, which needs the `snip` binary on `PATH` for two of its probes.

## License

MIT
