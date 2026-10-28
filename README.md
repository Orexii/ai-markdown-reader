# Clear Markdown Reader

Listen to Markdown in VS Code with a **natural neural voice that runs on your computer**. The reader
shows your document, highlights each sentence and word as it is spoken, follows along as it reads,
and gives you podcast-style controls: back 10 seconds, forward 30, previous or next sentence, any
speed from 0.5× to 3×.

Tables are read with their column names, bullet points flow as sentences, and technical text such as
`ANFObservabilityDB`, `IcM`, `v1.2.3` or `$12.50` is pronounced the way people say it.

## Install

Download the package for your computer from the
[latest release](https://github.com/Orexii/clear-markdown-reader/releases/latest), then in VS Code run
**Extensions: Install from VSIX…** (or `code --install-extension <file>.vsix`).

| Your computer | Package |
| --- | --- |
| Windows (Intel/AMD) | `clear-markdown-reader-win32-x64-<version>.vsix` |
| Windows on Arm | `clear-markdown-reader-win32-arm64-<version>.vsix` |
| macOS, Apple silicon | `clear-markdown-reader-darwin-arm64-<version>.vsix` |
| macOS, Intel | `clear-markdown-reader-darwin-x64-<version>.vsix` |
| Linux x64 | `clear-markdown-reader-linux-x64-<version>.vsix` |
| Linux Arm64 | `clear-markdown-reader-linux-arm64-<version>.vsix` |

Install it in **desktop VS Code on the computer you are listening on**. It runs next to your speakers,
so it also reads files opened through WSL, SSH, containers and Codespaces. VS Code for the Web is
not supported.

The first time you read, the reader offers to download the natural voice: **326 MB, once**
(or 92 MB with the `compact` quality setting). After that, speech is generated entirely on your
computer. You can also run **Clear Markdown: Download Natural Voice** ahead of time.

## Use

Open a Markdown file and click the speaker icon in the editor title, or run **Clear Markdown: Read
Aloud**. It resumes where you stopped last time. You can also **Read Aloud from Cursor**
(`Ctrl+Alt+Enter`, `Cmd+Alt+Enter` on macOS), **Read Aloud from the Start**, or select text and
**Read Selection Aloud**.

The reader opens beside your editor. VS Code only lets a panel play sound after you click or press a
key in it, so the very first time you may see **Start listening**: press Space or click it. The panel
then stays ready, so later documents start immediately.

| In the reader | Action |
| --- | --- |
| Space or K | Play or pause |
| ← or J | Back 10 seconds (`clearMarkdown.skipBackSeconds`) |
| → or L | Forward 30 seconds (`clearMarkdown.skipForwardSeconds`) |
| Shift+← / Shift+→ (or , / .) | Previous / next sentence |
| Shift+↑ / Shift+↓ (or [ / ]) | Previous / next paragraph |
| - / + | Slower / faster |
| Home | Back to the start |
| F | Follow the voice again |
| ? | Show shortcuts |
| Click a word | Read from that word |
| Alt+Click | Show that line in the editor |
| Ctrl/Cmd+Click a link | Open the link |

The progress bar shows the time left at your speed; the marks on it are headings and can be clicked.
While reading, the lines being spoken are also highlighted in your Markdown editor. If you scroll away,
the reader stops following and shows **Back to reading**.

From the editor, while the reader is open: `Ctrl+Alt+P` play/pause, `Ctrl+Alt+,` back,
`Ctrl+Alt+.` forward (`Ctrl+Cmd+…` on macOS), or click the time in the status bar. Every control is
also a **Clear Markdown** command in the Command Palette, so you can assign your own keys.

## How documents are read

- **Lists** read as flowing sentences, without saying "bullet". Numbered steps keep their numbers,
  task items say whether they are completed, and nested items stay in order.
- **Tables** first say how many rows and which columns they have, then read each row with its column
  names: *"Mail. State: Ready. Next action: Send the draft."* The cell and its header light up as they
  are spoken, and empty cells are read as "empty". Column-by-column reading is in the settings.
- **Code blocks** are announced with their language and length by default; they can be read line by
  line or skipped. **Raw HTML** is shown as a placeholder and not read.
- **Headings, quotes and callouts** (`> [!NOTE]`, `> [!WARNING]` …) get natural pauses and a short cue.
- **Links** read their text; bare URLs read just the site name. **Images** read their description.
- **Technical text:** acronyms are spelled (`ANF`, `IcM`, `VMs`), identifiers are split
  (`DataHarborConfig` → "Data Harbor Config"), and money, times, years, ranges and versions are
  normalized. Add your own words with `clearMarkdown.pronunciations`, for example
  `{ "Kusto": "kuss toe", "Rakeem": "/ɹɑːkˈiːm/" }` (slashes mean IPA phonemes). Put it in workspace
  settings to share it with your team.

## Voices

The natural voice is [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M), an open (Apache-2.0)
neural text-to-speech model, run with ONNX Runtime in a separate process so VS Code stays responsive.
Words are converted to the exact phonemes Kokoro was trained with, using the curated lexicons of
[misaki](https://github.com/hexgrad/misaki), Kokoro's own pronunciation frontend; eSpeak NG covers
words the lexicon does not know.
**Heart** (American English, the model authors' highest-graded voice) is the default; choose among 28
American and British voices in the reader. Other voices download on demand (0.5 MB each).

On the 16-core machine it was developed on, four CPU threads generate speech three to four times
faster than real time. The reader prepares the next minute or two ahead, so playback and skipping
stay smooth. Use `clearMarkdown.threads` to
change how many threads it uses.

If you prefer, or if the natural voice cannot run, choose **Use the system voice** in the reader
settings (`clearMarkdown.engine`: `system`). This uses Windows voices, macOS `say`, or `espeak-ng` on
Linux (`sudo apt install espeak-ng`); their quality varies and word highlighting is approximate.

The voices in the ChatGPT, Gemini and Claude apps come from much larger models running on their
providers' servers. Kokoro is a small model you can run privately on a laptop; it is far more natural
than classic system voices, but it is not identical to those cloud voices.

## Optional: Copilot descriptions

Each table and code block has a **Describe table** / **Explain code** button. It sends **only that
block** to a GitHub Copilot model you choose, after a confirmation, and shows the suggested spoken
description for you to review. Nothing changes until you choose **Read this instead**, and
**Use the original narration** switches back. Don't use it for content you are not allowed to share.

## Privacy

- Your documents are read on your computer. The natural voice and system voices never send text anywhere.
- The only network access is downloading the voice files you ask for, from a pinned revision on Hugging
  Face; each file's size and SHA-256 are verified before use. They are stored in VS Code's global
  storage. **Clear Markdown: Remove Downloaded Natural Voice** deletes them.
- Copilot descriptions are the only feature that sends text, only when you click the button.
- No telemetry. Raw HTML in documents is never rendered or run.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `clearMarkdown.engine` | `natural` | `natural` (Kokoro, local) or `system` |
| `clearMarkdown.naturalVoice` | `af_heart` | Natural voice |
| `clearMarkdown.naturalQuality` | `best` | `best` (326 MB) or `compact` (92 MB, slightly lower quality) |
| `clearMarkdown.systemVoice` | | Operating-system voice for the system engine |
| `clearMarkdown.rate` | `1` | Speed, 0.5–3, pitch preserved |
| `clearMarkdown.skipBackSeconds` / `skipForwardSeconds` | `10` / `30` | Skip lengths |
| `clearMarkdown.tableMode` | `rows` | `rows` or `columns` |
| `clearMarkdown.codeBlocks` | `announce` | `announce`, `read` or `skip` |
| `clearMarkdown.highlightWords` | `true` | Highlight each word as well as the sentence |
| `clearMarkdown.followInEditor` | `true` | Highlight the lines being read in the editor |
| `clearMarkdown.pronunciations` | `{}` | Your pronunciation dictionary |
| `clearMarkdown.threads` | `0` | CPU threads for the natural voice (0 = automatic) |

## Troubleshooting

- **"Start listening" appears.** VS Code requires one click or key press in the reader before sound
  can play. Press Space.
- **The natural voice could not start.** The reader says why and offers the system voice. Check that
  you installed the package for your platform.
- **The download fails behind a proxy.** VS Code's `http.proxy` settings apply. You can retry, or use
  the system voice meanwhile.
- **The document changed.** The reader shows a Refresh button and keeps your place.

## Development

Requires Node.js 22. Set `ONNXRUNTIME_NODE_INSTALL=skip` before `npm ci` to avoid ONNX Runtime's
optional GPU downloads on Linux.

```sh
npm ci
npm run check                                       # type-check
npm test                                            # unit, document, engine and webview tests
npx tsc && node tools/fetch-model.mjs .model        # pinned test model (92 MB)
CMR_MODEL_DIR=.model npm test                       # also run the real Kokoro model
node tools/smoke.mjs .model                         # bundled engine + this platform's runtime
node tools/e2e.mjs --code <VS Code executable> --model .model --quality compact
                                                    # real VS Code; add --mode gesture for a normal launch
npm run package                                     # releases/*.vsix for all six platforms
```

`tools/e2e.mjs` works from WSL with the Windows `Code.exe`. CI runs the unit and real-model tests and
the bundled-engine smoke test on Windows, macOS and Linux (x64 and Arm), then packages every platform.

## License

The source code is [MIT](LICENSE). Packaged releases include eSpeak NG, which is GPL-3.0-or-later, so
each `.vsix` as a whole is distributed under GPL-3.0-or-later. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for all bundled components and the downloaded model.
