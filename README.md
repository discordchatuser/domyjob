# domyjob

A minimal local chat UI for Codex, with a Node backend and Vite frontend. The backend connects to your installed `codex` binary through Codex app-server and uses your existing Codex login.

## Features

- **Thread images:** PNG, JPEG, GIF and WebP images referenced by replies or emitted by Codex are saved in `.data/images/<chat-id>/`. Click a preview or **Images** to browse the thread gallery, use arrow keys to navigate, or download a copy. Saved images survive reloads and are removed when the thread is deleted; original files in your working directory are retained. Downloads are limited to 20 MB per image.

- **Voice:** click **Mic** to dictate into the prompt, then **Stop mic** to review and send. Escape also stops dictation. The Mic button is hidden in browsers without speech recognition or on insecure pages. Recognition uses your browser language and requires a supported browser and microphone permission. Browser speech recognition may send audio to its speech service and require internet access; no audio is stored by this app.

- **Interactive choices:** Codex can pause to ask questions. Pick an option (click or use arrow keys), switch your choice, or type your own answer, then click **Send answers** to continue the same turn.
- **Working directory:** choose an existing folder for each new thread. To build beside this project, select its parent folder and ask Codex to create a new subfolder.
- **Multiple threads:** create conversations and switch between them in the sidebar. History is saved locally across restarts.
- **Terminal-style transcript:** dark monospace layout with streamed replies, compact tool activity, exit statuses, and collapsible command output. Older command history uses the same compact display.
- **Command shortcut:** press Cmd+. (Ctrl+. on other keyboards), type a command, and press Escape to attach it. Enter sends it. You can also ask “run ls -la and give me the output”.
- **Thread deletion:** × interrupts the active turn, cleans tracked background terminals, and deletes the Codex thread and chat history. Cleanup failures keep the chat available for retry. Independently detached processes aren't covered.
- **Automatic model:** follows your local Codex configuration. Commands can write inside the working directory; approval requests aren't supported.

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
