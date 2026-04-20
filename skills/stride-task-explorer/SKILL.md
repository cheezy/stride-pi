---
name: stride-task-explorer
description: Use this skill after claiming a Stride task to explore the codebase before beginning implementation. Read key_files, find related tests, search for patterns_to_follow, and produce a structured summary so the implementation step has full context. This is Pi's inline equivalent of the task-explorer subagent in sibling plugins (Claude Code / Codex CLI).
---

# Stride: Task Explorer (Inline)

## Purpose

Targeted codebase exploration for Stride kanban tasks. Your role is to read and analyze the specific files and patterns referenced in the current task's metadata and produce a structured summary that enables confident implementation.

**Pi context:** Pi does not ship with native subagent dispatch. In sibling plugins this runs as an isolated subagent with its own context; on Pi you execute these instructions inline, in your main context. The output shape and rigor are identical — only the isolation changes.

## When to invoke

Invoke this skill after claiming a Stride task, before writing any code, whenever the decision matrix in `stride-subagent-workflow` indicates exploration is required (medium+ complexity, 2+ key_files, defect type). Skip exploration for small tasks with 0–1 key_files per the matrix.

## Inputs (from your current context)

When invoked as a skill, the Stride task metadata is already present in your context from the claim response. Use any of these fields that are populated:

- `key_files` — array of `{file_path, note, position}` objects
- `patterns_to_follow` — newline-separated string of patterns to replicate
- `where_context` — UI location or code area to orient around
- `acceptance_criteria` — newline-separated definition of done
- `testing_strategy` — object with `unit_tests`, `integration_tests`, `manual_tests`, `edge_cases`

Use these fields to guide a focused exploration — never explore aimlessly.

## Steps

1. **Read Key Files**
   - Read every file listed in the task's `key_files` array
   - For each file, note: its purpose, public API (exported functions), key data structures, and current line count
   - If a key_file `note` says "New file to create", check the parent directory for existing files to understand naming conventions and module patterns
   - If a key_file does not exist yet, note this and move on

2. **Find Related Test Files**
   - For each key_file, search for its corresponding test file (e.g., `lib/foo.ex` → `test/foo_test.exs`, `lib/foo_web/live/bar.ex` → `test/foo_web/live/bar_test.exs`)
   - Read each test file to understand existing test patterns, test helpers used, and factory/fixture setup
   - Note which functions already have test coverage and which don't

3. **Search for Patterns to Follow**
   - If `patterns_to_follow` is provided, find and read the referenced source files or code patterns
   - Extract the specific pattern: function signatures, module structure, naming conventions, error handling approach
   - Note exactly how the pattern should be replicated in the new implementation
   - If patterns reference other modules, read those modules to understand the full pattern chain

4. **Navigate Where Context**
   - If `where_context` is provided, navigate to that location in the codebase
   - Read surrounding files to understand the neighborhood: sibling modules, shared utilities, common imports
   - Identify any shared helper modules or components that should be reused

5. **Analyze Testing Strategy**
   - If `testing_strategy` is provided, review its `unit_tests`, `integration_tests`, `manual_tests`, and `edge_cases`
   - For each test type, find existing examples of similar tests in the codebase
   - Note test helper modules, factory functions, and setup patterns that should be reused

6. **Produce Structured Summary**
   - Organize findings by key_file, with subsections for: file state, related tests, patterns found, and dependencies
   - Highlight any potential conflicts or concerns (e.g., a key_file was recently modified, a pattern has been deprecated)
   - List all helper modules, utilities, and shared functions that should be reused rather than reimplemented
   - Keep the summary concise and actionable — focus on what the implementation step needs to know

## Output: the `explorer_result` field

After completing exploration, you will include `explorer_result` in the Stride `/complete` payload. Because you ran this skill inline (no subagent dispatch), use the **dispatched shape** — you genuinely performed the exploration, so the result is "dispatched" in the sense that the work happened, even though no separate agent was spawned.

```json
"explorer_result": {
  "dispatched": true,
  "summary": "<at least 40 non-whitespace characters describing what was explored — file list, patterns found, helpers identified>",
  "duration_ms": <wall-clock milliseconds spent in this skill>
}
```

See `stride-completing-tasks/SKILL.md` for the full schema and the alternate skip form (used only when the decision matrix skipped exploration entirely).

## Important constraints

- Only explore files referenced by the task metadata — do not wander into unrelated areas
- If a field is missing or empty, skip that exploration step
- Never make changes to any files during this step — the skill is read-only
- Do not interact with the Stride API — you only explore code; the `/complete` call happens later
- Return your findings in a single, well-organized response
- Keep the summary substantive — a one-line summary fails the 40-character minimum that `stride-completing-tasks` enforces
