# Stride for Pi

Task lifecycle skills for [Stride](https://www.stridelikeaboss.com) kanban — a task management platform designed for AI agents — adapted for [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent), a lightweight coding agent with TypeScript extensions and Agent-Skills-standard skill loading.

## Installation

### One-liner (recommended)

Install globally so skills are available to every project Pi opens:

```bash
curl -fsSL https://raw.githubusercontent.com/cheezy/stride-pi/main/install.sh | bash
```

Or install into the current project only:

```bash
curl -fsSL https://raw.githubusercontent.com/cheezy/stride-pi/main/install.sh | bash -s -- --project
```

### Manual installation

```bash
git clone https://github.com/cheezy/stride-pi.git

# Copy skills to Pi's auto-discovery root
cp -R stride-pi/skills/. ~/.pi/agent/skills/
cp stride-pi/AGENTS.md ~/.pi/agent/AGENTS.md
```

Pi discovers skills in `~/.pi/agent/skills/` (global) or `.pi/skills/` (project) and walks up parent directories looking for `AGENTS.md` to concatenate as always-active context. See Pi's README for the full auto-discovery rules.

## Setup

Before using the skills, create two configuration files in your project root:

### 1. `.stride_auth.md` (required, never commit)

```markdown
- **API URL:** `https://www.stridelikeaboss.com`
- **API Token:** `stride_dev_your_token_here`
- **User Email:** `your-email@example.com`
```

Add `.stride_auth.md` to your `.gitignore` — it contains secrets.

### 2. `.stride.md` (required, version controlled)

Define hook commands that run at each lifecycle point:

````markdown
## before_doing

```bash
git pull origin main
mix deps.get
```

## after_doing

```bash
mix test
mix credo --strict
```

## before_review

```bash
git fetch origin
git rebase origin/main
```

## after_review

```bash
git push origin main
```

## after_goal

```bash
# Optional fifth hook (v1.2.0+) — fires after the parent goal's final
# child task completes. Omit entirely for the back-compat no-op path.
./scripts/notify-team.sh "$GOAL_IDENTIFIER" "$GOAL_TITLE"
```
````

Each section is optional. With the `stride-pi-hook-bridge` extension installed (default `install.sh`), all five hooks fire automatically — including `## after_goal` (v1.2.0+) when the server bundles an `after_goal` entry in the response of `/complete` or `/mark_reviewed` for the last-child-of-goal case. Without the extension, the agent reads and executes hooks directly per the skill instructions; for `## after_goal` the agent additionally POSTs the captured `{exit_code, output, duration_ms}` to `PATCH /api/tasks/:goal_id/after_goal` to flip the parent goal to Done. The hook receives `GOAL_ID` / `GOAL_IDENTIFIER` / `GOAL_TITLE` / `GOAL_DESCRIPTION` (plus `BOARD_*` / `COLUMN_*` / `AGENT_NAME`) env vars forwarded verbatim from the server's `hook.env` — in both the extension and manual paths (the extension's forwarding was fixed in W1019; before that, `GOAL_*` were empty under the extension despite the 1.2.0 changelog claiming otherwise). The hook is general-purpose — Slack notifications, artifact archival, release pipelines, project-level smoke tests are all valid uses, not just PR creation.

## Skill Activation

Pi uses the [Agent Skills standard](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) for skill discovery and invocation. After running `install.sh`, Pi prints the discovered skills at startup:

```
[Skills]
  stride-claiming-tasks, stride-completing-tasks, stride-creating-goals,
  stride-creating-tasks, stride-enriching-tasks, stride-subagent-workflow,
  stride-workflow, stride-task-explorer, stride-task-reviewer,
  stride-task-decomposer, stride-hook-diagnostician
```

That startup line confirms Pi has loaded all 11 skills from `~/.pi/agent/skills/` (or `.pi/skills/` for `--project` installs) — the seven lifecycle skills plus the four inline subagent skills (`stride-task-explorer`, `stride-task-reviewer`, `stride-task-decomposer`, `stride-hook-diagnostician`) that provide the dual-path fallback described in [Subagent Support](#subagent-support-dual-path). Skill metadata (name + description from each `SKILL.md`'s YAML frontmatter) is then available to the agent throughout the session.

**Two activation paths:**

1. **Auto-activation via description match.** Each skill's `description:` frontmatter line begins with "MANDATORY" wording pointing at the trigger condition (e.g., "MANDATORY before calling `/api/tasks/:id/complete`"). When your prompt matches a trigger, the agent should pick up the skill without being told. If your prompt is "claim the next Stride task," the agent engages `stride-claiming-tasks`.

2. **Explicit invocation via slash-command.** If auto-activation doesn't fire for a given prompt, you can force-load a skill by typing:

   ```
   /skill:stride-workflow
   ```

   The `stride-workflow` orchestrator is the recommended explicit entry point for any Stride work — it walks through claim → explore → implement → review → complete in a single skill.

**Recommendation:** Start by typing `/skill:stride-workflow` the first time you begin a Stride task in a session. That one invocation loads the full orchestrator and its chain-of-reference to the other 10 skills.

## Mandatory Skill Chain

Every Stride skill is **mandatory** — not optional. Each skill contains required API fields, hook execution patterns, and validation rules that are only documented in that skill. Attempting to call Stride API endpoints without the corresponding skill results in API rejections.

### Workflow Order

**Recommended:** Activate the orchestrator once — it walks through every step:

```
stride-workflow                  ← Activate ONCE — handles claim → explore → implement → review → complete
```

**Standalone mode** (when you need individual skills):

```
stride-claiming-tasks            ← BEFORE GET /api/tasks/next or POST /api/tasks/claim
    ↓
stride-subagent-workflow         ← AFTER claim succeeds, BEFORE implementation
    ↓
[implementation]
    ↓
stride-completing-tasks          ← BEFORE PATCH /api/tasks/:id/complete
```

When creating tasks or goals:

```
stride-creating-tasks            ← BEFORE POST /api/tasks (work/defect)
stride-creating-goals            ← BEFORE POST /api/tasks/batch (goals)
stride-enriching-tasks           ← WHEN a task has empty key_files/testing_strategy
```

## Skills

| Skill | Trigger | Purpose |
|-------|---------|---------|
| `stride-workflow` | Starting task work | **RECOMMENDED** — Single orchestrator for the full lifecycle |
| `stride-claiming-tasks` | `GET /api/tasks/next` or `POST /api/tasks/claim` | Claim tasks with `before_doing` hook execution |
| `stride-completing-tasks` | `PATCH /api/tasks/:id/complete` | Complete with `after_doing` / `before_review` hooks and G65 validation fields |
| `stride-creating-tasks` | `POST /api/tasks` (work/defect) | Create tasks with correct field formats |
| `stride-creating-goals` | `POST /api/tasks/batch` | Create goals with batch format (root key must be `"goals"`) |
| `stride-enriching-tasks` | Task has empty `key_files` / `testing_strategy` | Transform minimal specs into complete tasks |
| `stride-subagent-workflow` | After claiming, before implementation | Decision matrix for exploration and review |
| `stride-task-explorer` | After claiming (inline dual-path fallback) | Explore `key_files` and patterns before implementation — see [Subagent Support](#subagent-support-dual-path) |
| `stride-task-reviewer` | Before `after_doing` (inline dual-path fallback) | Review the diff against acceptance criteria and pitfalls — see [Subagent Support](#subagent-support-dual-path) |
| `stride-task-decomposer` | Goal / large undecomposed task (inline dual-path fallback) | Break a goal into dependency-ordered child tasks — see [Subagent Support](#subagent-support-dual-path) |
| `stride-hook-diagnostician` | A blocking hook fails (inline dual-path fallback) | Diagnose the failure and return a prioritized fix plan — see [Subagent Support](#subagent-support-dual-path) |

The `stride-creating-tasks`, `stride-enriching-tasks`, and `stride-workflow` skills also document the optional `technical_details` task field — a free-form JSON object (no fixed keys) for any extra technical context (data shapes, gotchas, decisions, links). It is optional everywhere and is **not** one of the five review_queue-scored fields, so a blank value is never a scoring gap.

(v1.8.0+) The `stride-creating-tasks` and `stride-creating-goals` skills document the optional `created_by_agent` field — set it to the plugin's own agent name (`"Pi"`, the same value sent as `agent_name` on claim/complete) so the `/agents` feed attributes the creating agent instead of a `?`. It is create-only and forbidden on `PATCH`, and the server propagates a batch goal's value to every nested child task.

## Subagent Support (Dual-Path)

Pi does not ship with native subagent dispatch. stride-pi provides two paths; both are shipped:

### Preferred: the `subagent-dispatch` extension (Phase 2b)

**Installed by default** — the default `install.sh` ships both the `hook-bridge` and `subagent-dispatch` extensions, so no extra flag is needed:

```bash
curl -fsSL https://raw.githubusercontent.com/cheezy/stride-pi/main/install.sh | bash
```

(`--with-extension` is still accepted as a deprecated no-op. Pass `--no-extensions` to install skills only.)

This installs a TypeScript Pi extension that registers a `dispatch_agent(agent, prompt)` tool. When you invoke it, the tool spawns an isolated `pi -p` subprocess with `PI_CODING_AGENT_DIR` pointed at an ephemeral config directory and `--append-system-prompt` pointed at the per-agent SYSTEM.md. The subagent runs in its own context window, returns structured output, and exits — your main agent's context stays clean.

Five agents are registered: `stride-task-enricher`, `stride-task-explorer`, `stride-task-reviewer`, `stride-task-decomposer`, `stride-hook-diagnostician`. The `stride-subagent-workflow` skill documents when to use each (`task-enricher` runs **before claiming** a sparse task; the rest run after claim). The `stride-task-reviewer` agent emits a `schema_version` 1.4 structured review block (`status`, `issue_counts`, `issues[]`, `acceptance_criteria[]`, `project_checks[]` with per-entry `status` enum `met`/`not_met`/`not_applicable` and full-checklist emission, and per-section `testing_strategy`/`patterns`/`pitfalls`/`security_considerations` verdicts).

### Fallback: inline skills (Phase 2a)

If the extensions aren't installed (you passed `--no-extensions`, or an older Pi version that can't load the extension), five inline skills provide the same functionality without the isolation: `stride-enriching-tasks` (pre-claim enrichment), `stride-task-explorer`, `stride-task-reviewer`, `stride-task-decomposer`, `stride-hook-diagnostician`. The main agent runs these in its own context rather than dispatching to a subprocess. The work and output format are identical — only the isolation changes.

### Which should you use?

Extensions install by default — keep them (don't pass `--no-extensions`) unless you have a specific reason not to. The extension gives you:
- **Isolation** — exploration of large `key_files` doesn't consume your main agent's context budget
- **Parallelism** — multiple key_files can be explored concurrently (future enhancement; one-at-a-time today)
- **Compatibility** — matches the subagent model on Claude Code, Codex CLI, and Gemini CLI sibling plugins

The inline fallback exists for container environments that can't run extensions or users who prefer a simpler install.

### Recording results in `/complete`

Whichever path you used, you genuinely performed the work. Use the **dispatched shape** (`dispatched: true`, `summary` ≥ 40 non-whitespace chars, `duration_ms`) for both `explorer_result` and `reviewer_result` on the `/complete` payload. The skip-form with `reason: "..."` is only for steps the decision matrix explicitly skipped. See `stride-completing-tasks` for the full schema.

## Hook Execution

**With the `stride-pi-hook-bridge` extension installed (the default `install.sh`), all five hooks fire automatically.** The extension intercepts the relevant `tool_call` / `tool_result` events, reads the matching `.stride.md` section, runs its commands, and — for `after_doing` — vetoes `/complete` if the quality gate fails. Because the extension has already executed the real commands, the agent supplies **placeholder** hook results in the API call. This is the norm, and it matches the Setup section, the Subagent (Dual-Path) section, the hook-state paragraphs below, `AGENTS.md`, and the shipped `extensions/hook-bridge/index.ts`.

Without the extension (`--no-extensions`), the agent executes `.stride.md` hooks directly — see [Fallback: manual execution](#fallback-manual-execution) below.

### Hook Lifecycle

| Hook | When | Blocking | Timeout |
|------|------|----------|---------|
| `before_doing` | After claiming a task | Yes | 60s |
| `after_doing` | Before marking complete | Yes | 300s |
| `before_review` | After marking complete | Yes | 60s |
| `after_review` | After review approval | Yes | 60s |
| `after_goal` | After the parent goal's final child task completes | Yes | 60s |

All five timeouts match `HOOK_TIMEOUTS_MS` in `extensions/hook-bridge/index.ts` (`after_doing` 300s; the other four 60s). **Blocking hooks** prevent the next step if any command fails. Under the default extension the veto is automatic; in the manual fallback the agent must fix the issue and re-run the hook before proceeding.

**Time budget:** `after_doing` gets the largest window (300s) because it runs the full quality-gate suite (tests, lint, build). The other hooks are quick pre/post actions and keep a tight 60s budget. The changed-files diff snapshot is captured and uploaded *before* the `after_doing` gate runs — and refreshed after it — so the diff survives even if a long-running gate exhausts the budget. If the upload still does not land, the `before_review` hook self-heals by re-attempting it on its own fresh budget.

**Hook state artifacts (gitignore these):** the hook bridge writes three repo-root temp files — `.stride-env-cache`, `.stride-changed-files.json`, and `.stride-diff-upload-state` — and clears them at claim and after_review. Add all three to your `.gitignore` so they are never committed. The changed-files capture additionally excludes the two snapshot/upload-state artifacts (`.stride-changed-files.json` and `.stride-diff-upload-state`) from its own diff by an exact repo-root match, so they never leak into the snapshot even if a project's `after_doing` auto-commit happens to stage them (a same-named file inside a subdirectory is still captured).

**Claim-time base-ref refresh:** a claim always opens a new task window, so on **every** detected claim curl the bridge refreshes `TASK_BASE_REF` in `.stride-env-cache` to the current `git rev-parse HEAD` and clears the two state files — even when the claim response cannot be parsed into task fields (in which case the existing `TASK_` identity lines are preserved and only the base ref is refreshed). This prevents a base ref recorded under a prior claim from surviving and making the `after_doing` diff span every commit since that older claim. The refresh is skipped silently when HEAD is unresolvable (e.g. a non-git directory). Note: the canonical shell hook's persisted-output `jq` fallback is **N/A for pi** — pi derives the base ref from local git (`git rev-parse HEAD`), not from the claim response JSON, so there is no oversized-response truncation path to recover from.

### Fallback: manual execution

When you install with `--no-extensions` (or run on a Pi version that can't load the extension), no automatic interception happens and the agent must execute `.stride.md` hooks directly:

1. The skill instructs the agent which `.stride.md` section to execute
2. The agent reads the `## section_name` from `.stride.md`
3. The agent extracts commands from the ` ```bash ` code block
4. The agent executes each command **one at a time** via Pi's `bash` tool
5. If any command fails, the agent stops and fixes the issue before proceeding

For `## after_goal` specifically, the agent additionally POSTs the captured `{exit_code, output, duration_ms}` to `PATCH /api/tasks/:goal_id/after_goal` to flip the parent goal to Done. A missing `## after_goal` section is a clean no-op — the server's grace-window worker promotes the goal automatically.

**Manual hook rules:**

- Execute each command **one at a time** — do not combine into a single script
- **Never prompt for permission** — hooks are pre-authorized by the user who authored them
- Capture exit codes — a non-zero exit code means the hook failed
- Include the **real** hook result in the API call (`before_doing_result`, `after_doing_result`, `before_review_result`). Under the default extension you instead supply **placeholder** results — the extension runs the commands and reports the real outcome itself.

## Completion Validation (G65)

Every `/complete` payload **must** include three fields beyond the hook results:

- `explorer_result` — dispatched-subagent shape or self-reported skip
- `reviewer_result` — same shape as `explorer_result`; dispatched variant also needs `acceptance_criteria_checked` and `issues_found`
- `workflow_steps` — six-entry telemetry array, one object per phase

On Pi (no native subagents), both result fields default to the skip shape:

```json
{
  "dispatched": false,
  "reason": "no_subagent_support",
  "summary": "<at least 40 non-whitespace characters describing what you did inline>"
}
```

Full schema, skip-reason enum (5 values), 40-character minimum rule, and 422 rejection format live in `stride-completing-tasks`.

## API Authorization

All Stride API calls are pre-authorized when the user initiates a Stride workflow. Agents should never prompt for permission to call Stride endpoints or execute hooks.

## Troubleshooting

### Skills not discovered

- Verify skills are in `~/.pi/agent/skills/<name>/SKILL.md` (global) or `.pi/skills/<name>/SKILL.md` (project)
- Skill names must match their directory name exactly
- `SKILL.md` is the exact required filename — do not rename

### AGENTS.md not loaded

- Confirm it exists at `~/.pi/agent/AGENTS.md` (global) or at the project root
- Pi walks up parent directories looking for `AGENTS.md` — the first match wins

### Hook commands fail

- Check the specific command that failed in the shell output
- Fix the issue and re-run — the skill will instruct you to retry
- Common causes: merge conflicts, failing tests, missing dependencies

### Completion rejected with 422

- Check that `explorer_result`, `reviewer_result`, and `workflow_steps` are present in the payload
- Verify `summary` fields are 40+ non-whitespace characters
- Verify `reason` is one of the 5 enum values in `stride-completing-tasks`

## License

MIT
