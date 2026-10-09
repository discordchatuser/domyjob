# domyjob

A minimal local chat UI for Codex, with a Node backend and React frontend built with Vite. The backend connects to your installed `codex` binary through Codex app-server and uses your existing Codex login.

## Features

- **Appearance:** the top-right color scheme picker offers Slate, Midnight and Sand. Your selection is saved in this browser and applies to all project views and dialogs. Terminal output keeps its own ANSI palette.

- **Project workspace:** projects have separate top tabs; each project has **Tasks**, **Documents**, **Terminal**, and **Chat** views. Project Chat uses one persistent orchestrator conversation with no thread controls. Loading the same project reuses it. General retains its conversation sidebar and multiple threads. Existing projects adopt their oldest conversation; other historical project threads stay saved. The orchestrator can delegate work through Codex subagent tools and integrates their results; delegation appears in the transcript.
- **Tasks & Docs:** the project sidebar opens a four-column task board and a project document reader. Create and edit tasks in a modal with optional annotated images; drag cards between columns. Graph and History are separate views. Saved task definitions go through JEV model/PRD impact evaluation and record requested PRD changes. Existing GSD plans and roadmap checkboxes are imported. Project chat uses the same task system through the `project_tasks` MCP tools and the bundled [project-tasks skill](skills/project-tasks/SKILL.md), which defines concise outcomes, scope, and completion criteria. Creating a task does not execute it. Returning to the board refreshes tasks captured in chat.

- **Projects from disk:** click **Load project…**, browse folders (including parent folders), or enter an absolute path, then load the selected folder into a new thread. For TROPHY, select `/Users/veljko/Arbeit/TROPHY`.
- **Project servers:** each loaded project has an editable server command and **Start server**, **Stop**, and a terminal console. Laravel projects default to `composer dev`; Node projects use `npm run dev` or `npm start`. Console output refreshes while the process runs, including stdout, stderr, startup errors and exit status. The xterm.js viewer renders ANSI colors, Unicode, carriage-return progress updates and cursor/erase sequences. Color output is enabled for new server processes. The console displays output only; it does not provide interactive shell input or a PTY. Servers are shared across threads with the same folder and continue when switching threads or reloading the page. Stop them explicitly; app shutdown also stops managed process groups. Output is capped at the latest 200,000 characters and resets on each start. Processes and output are not restored after restarting the backend.

- **JEV model routing:** Codex's advertised model catalog is loaded once at backend startup. Before each task, JEV selects a model from that catalog through OpenRouter. General chat offers **Task model → Auto · JEV** or a manual model override; project orchestrator routing is automatic and has no model selector; the transcript records the chosen model, difficulty, confidence and fallback warnings. The orchestrator uses the `jev_router` MCP `choose_model` tool before delegated subtasks. Task execution still uses your Codex login.

- **Thread images:** PNG, JPEG, GIF and WebP images referenced by replies or emitted by Codex are saved in `.data/images/<chat-id>/`. Click a preview or **Images** to browse the thread gallery, use arrow keys to navigate, or download a copy. Saved images survive reloads and are removed when the thread is deleted; original files in your working directory are retained. Downloads are limited to 20 MB per image.

- **Voice:** click **Mic** to dictate into the prompt, then **Stop mic** to review and send. Escape also stops dictation. The Mic button is hidden in browsers without speech recognition or on insecure pages. Recognition uses your browser language and requires a supported browser and microphone permission. Browser speech recognition may send audio to its speech service and require internet access; no audio is stored by this app.

- **Interactive choices:** Codex can pause to ask questions. Pick an option (click or use arrow keys), switch your choice, or type your own answer, then click **Send answers** to continue the same turn. Selections survive streaming updates and thread switches. Submitted questions remain as answered cards after reloads.
- **Working directory:** choose an existing folder for each new thread. To build beside this project, select its parent folder and ask Codex to create a new subfolder.
- **Multiple threads:** create conversations and switch between them in the sidebar. Each thread keeps its own unsent message and attached commands while switching. History is saved locally across restarts.
- **Terminal-style transcript:** dark monospace layout with streamed replies, compact tool activity, exit statuses, and collapsible command output. Older command history uses the same compact display.
- **Command shortcut:** press Cmd+. (Ctrl+. on other keyboards), type a command, and press Escape to attach it. Enter sends it. You can also ask “run ls -la and give me the output”.
- **Thread deletion:** × interrupts the active turn, cleans tracked background terminals, and deletes the Codex thread and chat history. Cleanup failures keep the chat available for retry. Independently detached processes aren't covered.
- **Local execution:** commands can write inside the working directory; approval requests aren't supported.

## Model routing

The backend loads its root `.env` automatically. Fill in the blank key in `.env` (or copy `.env.example` first on a new checkout), then restart the backend:

```dotenv
OPENROUTER_API_KEY=your-key-here
JEV_MODEL=typesafe/jev-1.13
```

`.env` is Git-ignored; `.env.example` contains only placeholders. Existing exported environment variables take precedence. Keep the key on the backend; it is never returned to the browser.

At startup, the app calls Codex `model/list` and follows pagination once, caches the catalog in memory, and writes `.data/model-catalog.json` for the local JEV MCP tool. Reloading the browser and submitting tasks reuse this catalog. Restart the backend to refresh it. If discovery fails, the UI reports Codex unavailable; a later connection attempt can retry initialization.

For each user task, the app sends the task, up to eight recent user/assistant messages (capped at 12,000 characters), and catalog descriptions to [JEV's Decisions API](https://openrouter.ai/docs/guides/community/jev-tutorial). This is an OpenRouter request billed separately from Codex. JEV chooses a model and difficulty, without an extra Codex inference preflight. Its confidence is recorded as decision metadata, not a guarantee of correctness. It does not generate explanations; the displayed reason is an application label.

The existing [routing policy](skills/model-route/SKILL.md) supplies preferred easy/medium/hard model profiles when those IDs appear in the catalog. JEV can also select newly advertised models using their descriptions. A manual **Task model** selection takes precedence over `CODEX_MODEL`; either bypasses JEV for that task. The manual selection resets after sending. Missing credentials, timeout, provider error or malformed decisions visibly fall back to the policy's medium model, Codex's default, or the first advertised model. A canceled request never starts execution.

Codex app-server also launches the local `jev_router` stdio MCP tool for new and existing project conversations. The orchestrator is instructed to call `choose_model` with each bounded subtask before spawning a worker and to use its returned model. This uses the same startup catalog and fallback policy. Delegation remains the orchestrator's responsibility; the app does not automatically fan out every request. **Task model** applies to the parent task; `CODEX_MODEL` also pins worker routing.

Tests use mocked OpenRouter responses; no real JEV request has been verified without your key.

Failed commands and tool calls pause the active Codex turn for a separate JEV recovery decision. JEV receives the action, exit status, bounded output, original request, retry history and sandbox restrictions. It chooses whether to continue, retry with a different approach, or stop. After a retry, the next action result is also inspected, even if it succeeds. Recovery allows at most two retries and six checkpoints per request. Missing credentials, provider errors, malformed decisions and confidence below 60% stop execution. These checks are billed through OpenRouter and appear in Usage; decisions appear in chat and the executing task's project History. Stopped tasks remain blocked rather than being marked complete. npm recovery instructions use a project-local cache for home-cache permission errors and treat missing offline packages as a separate blocker; this does not enable network access or shell escalation.

## Run

Install Node.js 20.19+ and a recent Codex CLI supporting the experimental background-terminal cleanup and thread-deletion APIs. Sign in with `codex login`, then:

```sh
npm install
npm run dev
```

Open http://127.0.0.1:5173. The backend runs on port 3001. Both bind locally; inference requires internet access.

Optional environment variables: `CODEX_BIN` (executable path), `CODEX_WORKDIR` (working directory), `CODEX_MODEL` (model override), `OPENROUTER_API_KEY`, and `JEV_MODEL` (optional decision-model override).

For a production build served locally:

```sh
npm run build
npm start
```

Open http://127.0.0.1:3001. Run tests with `npm test`.

Chat history lives in `.data/`, which is excluded from Git.

## Development

The frontend uses React components in `client/`, with `App.jsx` managing threads and streamed events. Question cards, transcript entries, and the image gallery have separate components; voice dictation uses a React hook. The Node HTTP backend and Codex app-server adapter live in `server/`.

```sh
npm test       # Backend tests and React DOM interaction tests
npm run build # Production frontend bundle
```

Tests cover routing, cancellation, saved model metadata, question selection during streaming, thread drafts, answer retries, gallery navigation, and mocked voice dictation. They do not make live inference requests. `npm run dev` watches the backend and serves the frontend through Vite; when using `npm start`, restart the backend after server changes and rebuild after frontend changes.

### Usage reporting

Open **Usage** in the header to inspect recorded JEV request costs, Codex thread tokens, and account limits. Project reports can switch to all projects. Refresh reloads local history; provider account information is cached for one minute.

Usage is stored in `.data/usage` and survives restarts and chat deletion. JEV costs come from the Decisions API response. OpenRouter key totals include all applications using that key; remaining allowance is a key limit, not an account credit balance. Missing costs remain unavailable. Codex does not report subscription usage as a dollar cost, so no API price estimates are applied.

Codex reporting keeps one cumulative snapshot per observed thread, preventing duplicate notifications from inflating totals. Resumed threads can include usage from before tracking began. The task column describes the latest observed task, not a per-task token breakdown. Subagents are included when their usage notifications are delivered during the orchestrator turn. JEV subtask calls pass the project path for attribution; calls without it appear as unassigned. Historical JEV requests and usage outside this app are only reflected in provider account totals.


Project task tools are configured when the backend starts Codex. Restart the backend after upgrading to enable them in existing project conversations. Both new and resumed orchestrator turns load the bundled task skill. The tools use the local backend at `http://127.0.0.1:3001` and call the same task endpoints as the UI. If evaluation is unavailable, the saved task remains visibly pending; the model must report the warning rather than claim evaluation succeeded.

The backend explicitly preapproves only its app-owned MCP tools: `project_tasks.list_tasks`, `create_task`, `update_task`, and `jev_router.choose_model`. This permits task capture with the existing `approvalPolicy: never` shell setting; other MCP tool approvals remain unchanged. Approval settings are passed as process-local Codex CLI overrides, without editing the user's Codex config. Restart the backend after changing these tool policies; existing conversations then resume with the updated configuration.
