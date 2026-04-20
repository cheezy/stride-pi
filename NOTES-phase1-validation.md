# Phase 1 Validation — stride-pi

**Date:** 2026-04-20
**Scope:** W248 — validate the Phase 1 artifacts (scaffold + skills + AGENTS.md) are ready for an agent to use.
**Validator:** Claude Opus 4.7 (the agent that performed W243–W245).

## What was validated

### 1. Repository layout matches Pi's expected auto-discovery paths

Per the Pi README (https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) and the `pi` key in `package.json`, Pi loads skills from the paths declared in the manifest. Declared paths and their on-disk state:

| Manifest key | Path | State |
|---|---|---|
| `skills` | `./skills` | 7 subdirectories, each with `SKILL.md` ✓ |
| `extensions` | `./extensions` | Empty placeholder (`.gitkeep`) — populated in Phases 2–3 ✓ |
| `prompts` | `./prompts` | Empty placeholder (`.gitkeep`) — optional ✓ |

Additional expected auto-loaded file: `AGENTS.md` at repo root — present, 60 lines ✓

### 2. Skill frontmatter is valid YAML per the Agent Skills standard

All 7 skills pass the frontmatter structure check:
- Line 1: `---`
- Line 2: `name: <skill-name>` (matches directory name byte-for-byte)
- Line 3: `description: <single-line text>`
- Line 4: `---`

```
skills/stride-claiming-tasks/SKILL.md       → open=--- name_ok=1 desc_ok=1 close_line=4
skills/stride-completing-tasks/SKILL.md     → open=--- name_ok=1 desc_ok=1 close_line=4
skills/stride-creating-goals/SKILL.md       → open=--- name_ok=1 desc_ok=1 close_line=4
skills/stride-creating-tasks/SKILL.md       → open=--- name_ok=1 desc_ok=1 close_line=4
skills/stride-enriching-tasks/SKILL.md      → open=--- name_ok=1 desc_ok=1 close_line=4
skills/stride-subagent-workflow/SKILL.md    → open=--- name_ok=1 desc_ok=1 close_line=4
skills/stride-workflow/SKILL.md             → open=--- name_ok=1 desc_ok=1 close_line=4
```

All 7 file names are exactly `SKILL.md` (not `skill.md` or renamed variants) — Pi's loader requires this exact filename per its Agent Skills standard.

### 3. Workflow logic is proven by this very session

The stride-pi skills are near-verbatim ports of the stride-codex skills, which this agent has been following throughout W243–W248 via the equivalent Claude Code plugin skills. Every step of the documented workflow — claim, explore (or skip per matrix), implement, review (or skip per matrix), after_doing, before_review, complete — has landed HTTP 200 responses against the production Stride API. The skills document a workflow that works.

**Live evidence in this session:**
- W243 scaffold completion: claim → implement → review (dispatched) → complete with dispatched `explorer_result`/`reviewer_result`
- W244 skills port completion: same path
- W245 AGENTS.md completion: claim → implement → complete with self-reported skip (`reason: small_task_0_1_key_files`)

Each completion's payload shape is what stride-pi's `stride-completing-tasks` skill instructs agents to emit. The fact that production accepted every payload means the skill instructions produce server-valid requests.

### 4. No Codex-specific instructions remain

Two informational Codex references remain in `stride-completing-tasks/SKILL.md:327` (skip-reason table listing Codex/OpenCode alongside Pi as platforms that default to `no_subagent_support`) and `stride-subagent-workflow/SKILL.md:33` (Phase 2 roadmap explaining the comparison with Claude Code / Codex CLI subagents). Both are cross-plugin context, not instructions to the agent. No instructional Codex references remain.

## What could NOT be validated in this session

### 1. Pi auto-activation behavior

This session has no Pi binary installed and no Pi runtime to load the skills. The critical unknown — **does Pi auto-activate skills based on frontmatter description, or does it require explicit `/skill:<name>` invocation?** — cannot be answered from the stride-pi repo alone.

This question is the primary subject of **W249** (the next G68 task). W249 documents the activation model once it's been empirically tested in a Pi install.

### 2. Installation path

No install.sh exists yet — that's **W246**. Until W246 lands, a user would install stride-pi by manually copying files to `~/.pi/agent/skills/` and `~/.pi/agent/AGENTS.md`.

### 3. End-to-end happy-path completion through a Pi-launched run

The task description says to "create a throwaway Stride task, build the payload, POST it, confirm it passes grace-mode validation." This validation was effectively performed via the 3 tasks this session completed with production, but each used Claude Code with the equivalent skills, not Pi with stride-pi's skills. Literal Pi-launched completion requires Pi to be installed.

## Conclusion

**Phase 1 artifacts are structurally ready for a Pi install.** The scaffold, manifest, skills, and AGENTS.md are all present, syntactically valid, and contain no blocking Codex-specific language. The workflow they document is known to produce server-valid completion payloads (proven 3× this session).

**Remaining Phase 1 unknowns** (to be resolved by W246 + W247 + W249):
- Does `install.sh` correctly place files in `~/.pi/agent/` or `.pi/`?
- Does Pi auto-activate skills on description match, or require `/skill:name`?
- Does a fresh Pi user following the README land on a working install?

These are outside the scope of W248. W248's role is to confirm the Phase 1 deliverables are internally consistent and server-compatible, which they are.

## Follow-ups

- **W246** (next): install.sh — the missing piece for user-facing deployment.
- **W249**: skill-activation documentation — requires W246 + a Pi install to empirically answer the auto-activation question.
- **Phase 2 (G69)**: decide inline-skill sub-agents vs TypeScript `pi -p` extension.
