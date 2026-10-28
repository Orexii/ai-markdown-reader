# Clear Markdown Reader

A VS Code desktop extension for **reading Markdown aloud**, not reading its
punctuation. Tables keep their column labels; bullets become flowing sentences.
Local narration does not send documents to a server. Optional GitHub Copilot
rewriting proposes a version you review before using.

## Install

Install the `.vsix` using **Extensions: Install from VSIX...** in VS Code's
Command Palette. Install it **locally on your desktop**, not inside WSL, SSH,
or a container. This extension intentionally runs next to your speakers.

Open a Markdown file, then choose **Clear Markdown: Read Aloud** from the Command
Palette or the speaker button in the editor title. For just part of a document,
select it and run **Clear Markdown: Read Selection Aloud**. Press Play in the
reader. [Try the demonstration](examples/demo.md).

### Supported desktops

| Desktop | Local speech engine | Setup |
| --- | --- | --- |
| Windows | Windows PowerShell + System.Speech | Uses installed SAPI voices, not every voice listed in Windows Narrator |
| macOS | Built-in `say` | Install additional system voices in macOS settings if desired |
| Linux | `espeak-ng`, falling back to `espeak` | Install `espeak-ng` using your distribution's package manager |

For example, Debian/Ubuntu: `sudo apt install espeak-ng`.

Local files and WSL/SSH/container workspaces use the **desktop's** speech engine
and audio device. Remote documents are read through VS Code's document API,
without trying to open a remote path on your desktop. Windows with or without
WSL is supported; the same applies to macOS and Linux remote clients.
Browser-only VS Code (`vscode.dev`) is not supported.

These are system voices: their quality varies. Linux eSpeak is intelligible but
not a human-sounding neural voice. Copilot improves *wording*, not voice quality.
There is no cloud TTS service or cloud API key requirement.

## Reading experience

- Play/pause, stop, next/previous passage, and 0.5x-2x playback speed.
- Sentence-aware short passages and next-passage audio prefetching.
- Click any passage to start there; Source reveals its Markdown location.
- Native voice picker; choosing a voice saves it in user settings.
- Row-by-row tables: "Row 1. Service: Mail. State: Ready."
- Column-by-column tables repeat the row identity to retain context.
- Empty table cells are explicitly spoken as "empty".
- Bold and italic markers disappear; link labels are read instead of long URLs.
  Explicit URL autolinks read the hostname.
- Ordered list numbering, nested items, task completion, and continuation
  paragraphs are preserved. Ordinary bullets are not prefixed with "bullet".
- Headings, blockquotes, image descriptions, code-block announcements, and YAML
  front matter are handled deliberately.
- HTML blocks are announced as omitted; their scripts are never executed.

Space toggles playback when focus is outside a button or form field.
Alt+Left/Right navigates passages. Native button keyboard activation still works.
Playback highlighting, keyboard controls, status announcements, and VS Code theme
colors are supported.

The reader is a **snapshot**. Reopen it after editing the source. Reading a
selection that starts inside a table/list may lose that structure; select the
whole structure, including table headers, for best results.

## Optional Copilot narration

Choose **Propose smoother narration with Copilot**, acknowledge the data-handling
warning, and select an available GitHub Copilot model. Existing Copilot access
and VS Code's model consent are required; subscription quotas still apply.

Only the current reader's narration text is submitted, not other files, linked
pages, or workspace context. It may be processed remotely. **Do not use this with
confidential, personal, customer, or otherwise unauthorized content.** Use the
local reader instead. Reading a small selection limits the request's scope.

Both versions are shown side by side. Nothing changes until you choose
**Apply proposal**. **Discard** keeps the current version; **Restore original
narration** returns to the deterministic version. Requests can be cancelled in
VS Code's progress notification.

The model is instructed not to summarize and to preserve facts, names, negations,
numbers, order, and table values. Its output is shape-checked, but that cannot
guarantee factual fidelity: **review it**. Failed, malformed, oversized, or
unauthorized responses show an error and leave the current narration unchanged.
Long documents may require a smaller selection.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `clearMarkdown.tableMode` | `rows` | `rows` or `columns`; also switchable in the reader |
| `clearMarkdown.codeBlocks` | `announce` | `announce` or `read` |
| `clearMarkdown.rate` | `1` | Initial playback speed, from 0.5 to 2 |
| `clearMarkdown.voice` | empty | System default, or an installed voice's ID |

Voice and table changes restart the reader at the beginning; table changes also
discard any AI proposal. Speed changes apply immediately to playback.

## Privacy and limitations

- No telemetry, embedded analytics, automatic model requests, or document uploads.
- Local narration uses temporary text files and WAV audio on the desktop.
  Text inputs are removed after synthesis. Audio is cached in a private temporary
  directory and removed when the reader closes. A crash or forced termination
  may leave a `clear-markdown-*` directory in the operating system's temp folder.
- The reader does not render document HTML, fetch images, or follow links.
- Standard Markdown and pipe tables are supported. Merged-cell HTML tables,
  diagrams, LaTeX pronunciation, footnote extensions, and specialized dialects
  are not semantically interpreted. Optional AI may improve some of these, but
  is not a substitute for checking the output.
- Only installed native voices are available. Missing engines, voices, synthesis
  failures, and playback failures produce visible errors.
- Windows launches the bundled speech script with a process-scoped execution
  policy; it does not change the machine's PowerShell policy. Organization policy
  may still prevent it from running.

## Development

Node.js 22+ and npm:

```sh
npm ci
npm run check
npm test
npm run package
```

The package command builds `clear-markdown-reader-0.1.0.vsix`. F5 in this
repository launches an Extension Development Host after building. Open the demo
and run Read Aloud.

Set `RUN_NATIVE_SPEECH=1` when running tests to additionally synthesize actual
audio using the current desktop's engine. The GitHub Actions matrix configures
this for Windows, macOS, and Linux. Unit tests cover narration, table values,
source mapping, AI response validation, process errors/cancellation, safe content
display, and playback state transitions. Browser media APIs are mocked in unit
tests; a real-desktop listening check is still needed to evaluate voice quality.

The packaging tool's `@azure/identity` dependency is pinned to compatible version
4.13.0 to avoid the MSAL Node 5/6 advisory GHSA-xcx6-jx8p-x3h5. It is not bundled
with the extension. Its UUID helper is overridden to the CommonJS-compatible
11.1.1+ release (the consumer uses the unchanged `v4` API) to address
GHSA-w5hq-g745-h8pq. Revisit these overrides when the tool adopts patched releases.

## License

[MIT](LICENSE).
