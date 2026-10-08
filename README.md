# domyjob

A minimal local chat UI for Codex, with a Node backend and React frontend built with Vite. The backend connects to your installed `codex` binary through Codex app-server and uses your existing Codex login.

## Features

- **Appearance:** the top-right color scheme picker offers Slate, Midnight and Sand. Your selection is saved in this browser and applies to all project views and dialogs. Terminal output keeps its own ANSI palette.

- **Project workspace:** projects have separate top tabs; each project has **Tasks**, **Documents**, **Terminal**, and **Chat** views. Project Chat uses one persistent orchestrator conversation with no thread controls. Loading the same project reuses it. General retains its conversation sidebar and multiple threads. Existing projects adopt their oldest conversation; other historical project threads stay saved. The orchestrator can delegate work through Codex subagent tools and integrates their results; delegation appears in the transcript.
- **Tasks & Docs:** open a loaded project and use **Tasks** or **Documents** for a four-column task board and a searchable document reader. The board reads GSD XML tasks from numbered `*-PLAN.md` files, uses matching summaries for completion/checkpoint evidence, and includes checkboxes from ROADMAP/TASKS/TODO/BACKLOG Markdown files. Cards link to source plans, summaries and related documents. Markdown renders headings, tables, code and checklists; PDF uses the browser viewer with an **Open original** fallback. This view is read-only; use **Refresh from disk** after edits. Dependency/build directories and symlinks are excluded from document indexing.

- **Projects from disk:** click **Load project…**, browse folders (including parent folders), or enter an absolute path, then load the selected folder into a new thread. For TROPHY, select `/Users/veljko/Arbeit/TROPHY`.
- **Project servers:** each loaded project has an editable server command and **Start server**, **Stop**, and a terminal console. Laravel projects default to `composer dev`; Node projects use `npm run dev` or `npm start`. Console output refreshes while the process runs, including stdout, stderr, startup errors and exit status. The xterm.js viewer renders ANSI colors, Unicode, carriage-return progress updates and cursor/erase sequences. Color output is enabled for new server processes. The console displays output only; it does not provide interactive shell input or a PTY. Servers are shared across threads with the same folder and continue when switching threads or reloading the page. Stop them explicitly; app shutdown also stops managed process groups. Output is capped at the latest 200,000 characters and resets on each start. Processes and output are not restored after restarting the backend.

- **Automatic model routing:** before each task, including in existing threads, Codex assesses difficulty using `skills/model-route/SKILL.md`, then the app selects Luna for easy work, Sol for medium work, or Astra for hard work. The header shows the active model and tier; the transcript records switches and reasons across reloads. Explicit model requests and `CODEX_MODEL` override the automatic choice. Unavailable models produce a visible fallback notice. Assessment is a separate read-only turn in the same conversation and adds an inference step before execution.

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

The backend reads [the routing skill](skills/model-route/SKILL.md) before every task, so edits to its criteria or model table apply to the next message. Difficulty depends on reasoning and uncertainty rather than task length:

| Difficulty | Model | Typical work |
| --- | --- | --- |
| Easy | `gpt-6-luna` | Small edits, formatting, obvious fixes |
| Medium | `gpt-6.1-sol` | Features, everyday debugging, connected decisions |
| Hard | `gpt-6-astra` | Complex architecture, ambiguous requirements, elusive bugs |

The app first runs a read-only assessment in the same Codex thread, then restores the working-directory sandbox and starts execution with the selected model. While assessing, the header shows **Assessing task difficulty…**. Once execution starts, it shows the model and difficulty; the conversation records the reason and any model change.

An explicitly requested model takes precedence over `CODEX_MODEL`, which otherwise pins the execution model. The app checks Codex's model catalog and displays a fallback notice if the preferred model is unavailable. An invalid or failed assessment stops execution and reports an error. This assessment adds an inference step to each task; answering an interactive question continues the existing task without another assessment.

## Run

Install Node.js 20.19+ and a recent Codex CLI supporting the experimental background-terminal cleanup and thread-deletion APIs. Sign in with `codex login`, then:

```sh
npm install
npm run dev
```

Open http://127.0.0.1:5173. The backend runs on port 3001. Both bind locally; inference requires internet access.

Optional environment variables: `CODEX_BIN` (executable path), `CODEX_WORKDIR` (working directory), and `CODEX_MODEL` (model override).

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
