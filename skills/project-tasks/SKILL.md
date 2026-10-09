---
name: project-tasks
description: Create or amend concise project tasks from chat using this application's task board, JEV impact evaluation, PRD change tracking, and audit log.
---

This application task board is the task system of record, including in projects that also use GSD planning files. Use the `project_tasks` MCP tools for requests to create, add, capture, or amend a project task. The current project's absolute path is supplied by the orchestrator instructions.

- Call `list_tasks` for the current project to check existing work. Use `update_task` when the user wants to amend a specific existing task; otherwise call `create_task`.
- Give the task a short action-oriented title. Keep its description concise: desired behavior, affected scope, and observable completion criteria. Include explicit removals or replacements. Preserve the user's constraints; do not invent the replacement or expand scope.
- Ask through `ask_user` when a missing detail prevents a useful definition. If the user wants to capture an unresolved idea now, state the open question in the description; the normal evaluation will flag clarification needs.
- Create through the tool, not a Markdown checkbox, standalone task file, direct data-store edit, or prose promise. The application owns persistence, JEV model and PRD impact assessment, task relationships, PRD change recording, and auditing. Do not perform a second JEV call to create the task or rewrite the PRD yourself during task capture.
- Creation schedules work; it does not implement it or mark it done. Report the saved title and task ID briefly, along with any evaluation warning or clarification needed. Claim success only after a successful tool response.
- If a tool call fails or times out, list tasks before retrying: the first request may already have saved the task. If the tool is unavailable, report that the task was not saved; do not substitute another task system.
