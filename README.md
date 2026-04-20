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
````

Each section is optional. Pi has no automatic hook interception, so the agent reads and executes these commands directly per the skill instructions.

## Skill Activation

Pi uses the [Agent Skills standard](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) for skill discovery and invocation. After running `install.sh`, Pi prints the discovered skills at startup:

```
[Skills]
  stride-claiming-tasks, stride-completing-tasks, stride-creating-goals,
  stride-creating-tasks, stride-enriching-tasks, stride-subagent-workflow,
  stride-workflow
```

That startup line confirms Pi has loaded all 7 skills from `~/.pi/agent/skills/` (or `.pi/skills/` for `--project` installs). Skill metadata (name + description from each `SKILL.md`'s YAML frontmatter) is then available to the agent throughout the session.

**Two activation paths:**

1. **Auto-activation via description match.** Each skill's `description:` frontmatter line begins with "MANDATORY" wording pointing at the trigger condition (e.g., "MANDATORY before calling `/api/tasks/:id/complete`"). When your prompt matches a trigger, the agent should pick up the skill without being told. If your prompt is "claim the next Stride task," the agent engages `stride-claiming-tasks`.

2. **Explicit invocation via slash-command.** If auto-activation doesn't fire for a given prompt, you can force-load a skill by typing:

   ```
   /skill:stride-workflow
   ```

   The `stride-workflow` orchestrator is the recommended explicit entry point for any Stride work — it walks through claim → explore → implement → review → complete in a single skill.

**Recommendation:** Start by typing `/skill:stride-workflow` the first time you begin a Stride task in a session. That one invocation loads the full orchestrator and its chain-of-reference to the other 6 skills.

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

## Subagent Support (Phase 2 — not yet available)

Pi does not ship with native subagent dispatch. The `task-explorer`, `task-reviewer`, `task-decomposer`, and `hook-diagnostician` named in `stride-subagent-workflow` are Claude Code / Codex CLI subagents from sibling plugins. For Pi, Phase 2 (tracked as G69 in Stride) will decide between:

- **2a: Inline skills** — port the 4 agents as additional skills the main agent invokes directly. No extension code; simpler, but loses isolation.
- **2b: TypeScript extension** — a `dispatch_agent(name, prompt)` tool that shells out to `pi -p` with per-agent `SYSTEM.md` overrides. Preserves isolation and parallelism.

Until Phase 2 lands, perform exploration and review **inline** using the task's `key_files`, `patterns_to_follow`, and `acceptance_criteria` as your guide. Record the outcome as a self-reported skip in the `explorer_result` and `reviewer_result` fields on `/complete`, using `reason: "no_subagent_support"` (or `self_reported_exploration` / `self_reported_review` for substantive inline work). See `stride-completing-tasks` for the exact payload shape.

## Hook Execution

**Pi has no automatic hook interception.** The agent must execute `.stride.md` hooks directly.

### How Hooks Work in Pi

1. The skill instructs the agent which `.stride.md` section to execute
2. The agent reads the `## section_name` from `.stride.md`
3. The agent extracts commands from the ` ```bash ` code block
4. The agent executes each command **one at a time** via Pi's `bash` tool
5. If any command fails, the agent stops and fixes the issue before proceeding

### Hook Lifecycle

| Hook | When | Blocking | Timeout |
|------|------|----------|---------|
| `before_doing` | After claiming a task | Yes | 60s |
| `after_doing` | Before marking complete | Yes | 120s |
| `before_review` | After marking complete | Yes | 60s |
| `after_review` | After review approval | Yes | 60s |

**Blocking hooks** prevent the next step if any command fails. The agent must fix the issue and re-run the hook before proceeding.

### Hook Execution Rules

- Execute each command **one at a time** — do not combine into a single script
- **Never prompt for permission** — hooks are pre-authorized by the user who authored them
- Capture exit codes — a non-zero exit code means the hook failed
- Include the hook result in the API call (`before_doing_result`, `after_doing_result`, `before_review_result`)

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
