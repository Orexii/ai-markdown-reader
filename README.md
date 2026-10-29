<p align="center"><img src="media/extension-icon.png" width="128" alt="Wagyu, a red Shiba Inu, reading a Markdown page aloud"></p>

# AI Markdown Reader - Read Aloud

Listen to Markdown in VS Code with a **natural AI voice that runs on your computer**. Your editor,
or the rendered **Read Aloud Preview**, highlights each sentence and word as it is spoken and scrolls
along with the voice. Small podcast-style controls sit in the status bar: back 10 seconds, forward 30,
play/pause and speed (0.5×, 1×, 1.5× and 2×, or any quarter step from 0.25× to 5×).

Tables are read with their column names, bullet points flow as sentences, and technical text such as
`ANFObservabilityDB`, `IcM`, `v1.2.3` or `$12.50` is pronounced the way people say it.

## Install

In VS Code, open the Extensions view (`Ctrl+Shift+X`, `Cmd+Shift+X` on macOS), search for
**AI Markdown Reader** and select **Install**. You can also run
`code --install-extension orexii.ai-markdown-reader`. VS Code picks the right package for your
computer (Windows, macOS or Linux, on x64 or Arm) and keeps it up to date.

To install without the Marketplace, download the package for your computer from the
[latest release](https://github.com/Orexii/ai-markdown-reader/releases/latest) and run
**Extensions: Install from VSIX…**.

| Your computer | Package |
| --- | --- |
| Windows (Intel/AMD) | `ai-markdown-reader-win32-x64-<version>.vsix` |
| Windows on Arm | `ai-markdown-reader-win32-arm64-<version>.vsix` |
| macOS, Apple silicon | `ai-markdown-reader-darwin-arm64-<version>.vsix` |
| macOS, Intel | `ai-markdown-reader-darwin-x64-<version>.vsix` |
| Linux x64 | `ai-markdown-reader-linux-x64-<version>.vsix` |
| Linux Arm64 | `ai-markdown-reader-linux-arm64-<version>.vsix` |

Install it in **desktop VS Code on the computer you are listening on**. It runs next to your speakers,
so it also reads files opened through WSL, SSH, containers and Codespaces. VS Code for the Web is
not supported.

If you used it under its earlier name, **Clear Markdown Reader**, uninstall that one: your settings
and the downloaded voice move over to AI Markdown Reader automatically.

The first time you read, the player offers to download the natural voice: **326 MB, once**
(or 92 MB with the `compact` quality setting). After that, speech is generated entirely on your
computer. You can also run **AI Markdown Reader: Download Natural Voice** ahead of time.

## Use

Open a Markdown file and click the speaker icon in the editor title, or run **AI Markdown Reader: Read
Aloud**. It resumes where you stopped last time. You can also right-click and **Read Aloud from
Cursor** (`Ctrl+Alt+Enter`, `Cmd+Alt+Enter` on macOS), **Read Aloud from the Start**, or select text
and **Read Selection Aloud**. While a file is being read, the editor title shows pause/resume and stop
instead of the speaker.

The sentence being read is highlighted in the editor, with the spoken word highlighted more strongly,
and the editor scrolls to keep it in view. Scroll away to look at something else and it stops
following; scroll back, or click **Back to reading** in the status bar, and it follows again. While a
file is being read, **Read Aloud from Cursor** jumps straight to the word under the cursor.

| Status bar | Action |
| --- | --- |
| ↺ 10 | Back 10 seconds (`aiMarkdownReader.skipBackSeconds`) |
| ▶ / ⏸ 0:42 / 5:10 | Play or pause; hover for Stop and the player |
| 30 ↻ | Forward 30 seconds (`aiMarkdownReader.skipForwardSeconds`) |
| 1× | Speed: 0.5×, 1×, 1.5× or 2×; **More speeds** offers every quarter step from 0.25× to 5× |

Keys work from anywhere while a file is being read: `Ctrl+Alt+P` play/pause, `Ctrl+Alt+,` back,
`Ctrl+Alt+.` forward (`Ctrl+Cmd+…` on macOS). Headset and keyboard media keys work where the system
supports them; their previous and next track keys skip by paragraph. Every control is also a
**AI Markdown Reader** command in the Command Palette (previous and next sentence or paragraph, faster,
slower, voice, speed), so you can assign your own keys.

### Reading the rendered preview

You can also listen while looking at the rendered Markdown. The **Read Aloud Preview** looks like VS
Code's Markdown preview and highlights the sentence and the spoken word as they are read, scrolling
along (with the same **Back to reading** behavior). Double-click any word, or right-click and choose
**Read Aloud from Here**, to start reading there. While its file is being read, the player's keys work
in the preview too (← / → by paragraph, Shift+← / Shift+→ by sentence and so on), while ↑ / ↓, Space and
Page Up / Page Down keep scrolling the page. Open it with **AI Markdown Reader: Open Read Aloud
Preview** (or **…to the Side**), from the editor's **Reopen Editor With…** list, or from the Explorer
context menu. It updates as you edit.

VS Code's own Markdown preview can't show which words are being read: VS Code doesn't let other
extensions highlight inside it. So when you press Play while VS Code's preview is open, Read Aloud reads
that file and shows the Read Aloud Preview in its place. To keep VS Code's preview instead (reading
without highlighting there), turn off `aiMarkdownReader.replaceMarkdownPreview`.

### The Read Aloud player

VS Code can only play sound from a web view, and only after you click or press a key in it. So the
audio lives in a small **Read Aloud** section at the bottom of the Explorer, not in a separate page.
The first time you read in a window, it opens and shows **Start reading**: click it or press Space.
After that you can collapse it, close the sidebar or switch views, and reading carries on.

The section shows the current heading, a progress bar with heading marks and the time left, and
buttons for previous paragraph, back 10 seconds, play/pause, forward 30 seconds, next paragraph, speed
and settings (voice, how tables and code are read, word highlighting, following, more speeds).
Previous paragraph goes back to the start of the current paragraph first, like the previous-track
button of a music player. The speed menu offers 0.5×, 1×, 1.5× and 2×; choose **More speeds…** at
the bottom of it (or turn on **More speeds** in the settings) for every quarter step from 0.25× to 5×.
On the right is a thin **vertical volume slider** with the speaker under it: drag it, click a spot or
scroll over it, and click the speaker to mute. If the sidebar is too narrow for one row, speed and
settings move to a second row. You can drag the section anywhere, for example into the panel or the
secondary side bar.

Click the section to use these keys. The arrows move through the text, like the |◀ ▶| buttons; a
modifier changes the step:

| Key | Action |
| --- | --- |
| ← / → | Previous / next paragraph (a table counts as one paragraph) |
| Shift+← / Shift+→ | Previous / next sentence (in a table, row by row) |
| Ctrl+← / Ctrl+→ (Option on macOS) | Back 10 / forward 30 seconds; J / L do the same |
| Shift+↑ / Shift+↓, Page Up / Page Down | Previous / next section (heading) |
| ↑ / ↓ | Volume; M mutes |
| Space or K | Play or pause |
| - / + | Slower / faster |
| Home | Back to the start |

Previous paragraph, sentence or section goes back to the start of the current one first, like the
previous-track button of a music player. Alt+← is not used because it is **Go Back** in VS Code.

## How documents are read

- **Lists** read as flowing sentences, without saying "bullet". Numbered steps keep their numbers,
  task items say whether they are completed, and nested items stay in order.
- **Tables** first say how many rows and which columns they have, then read each row with its column
  names: *"Mail. State: Ready. Next action: Send the draft."* The row is highlighted, and each cell
  and its column header light up as they are spoken. Empty cells are read as "empty". Column-by-column
  reading is in the settings.
- **Code blocks** are announced with their language and length by default; they can be read line by
  line or skipped. **Raw HTML** is not read.
- **Headings, quotes and callouts** (`> [!NOTE]`, `> [!WARNING]` …) get natural pauses and a short cue.
- **Links** read their text; bare URLs read just the site name. **Images** read their description.
- **Technical text:** acronyms are spelled (`ANF`, `IcM`, `VMs`), identifiers are split
  (`DataHarborConfig` → "Data Harbor Config"), and money, times, years, ranges and versions are
  normalized. Add your own words with `aiMarkdownReader.pronunciations`, for example
  `{ "Kusto": "kuss toe", "Rakeem": "/ɹɑːkˈiːm/" }` (slashes mean IPA phonemes). Put it in workspace
  settings to share it with your team.

## Voices

The natural voice is [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M), an open (Apache-2.0)
neural text-to-speech model, run with ONNX Runtime in a separate process so VS Code stays responsive.
Words are converted to the exact phonemes Kokoro was trained with, using the curated lexicons of
[misaki](https://github.com/hexgrad/misaki), Kokoro's own pronunciation frontend; eSpeak NG covers
words the lexicon does not know.
**Heart** (American English, the model authors' highest-graded voice) is the default; choose among 28
American and British voices in the player settings or with **AI Markdown Reader: Choose Voice**. Other
voices download on demand (0.5 MB each).

On the 16-core machine it was developed on, four CPU threads generate speech three to four times
faster than real time. The player prepares the next minute or two ahead and joins consecutive
sentences into one continuous track, so there is no gap or hitch between sentences, even at 2×. When
little audio is ready (just after starting or skipping), it generates shorter pieces so they arrive
in time. Use `aiMarkdownReader.threads` to change how many threads it uses. If speech ever falls behind,
the **AI Markdown Reader** output channel says so.

If you prefer, or if the natural voice cannot run, choose **Use the system voice** in the player
settings (`aiMarkdownReader.engine`: `system`). This uses Windows voices, macOS `say`, or `espeak-ng` on
Linux (`sudo apt install espeak-ng`); their quality varies and word highlighting is approximate.

The voices in the ChatGPT, Gemini and Claude apps come from much larger models running on their
providers' servers. Kokoro is a small model you can run privately on a laptop; it is far more natural
than classic system voices, but it is not identical to those cloud voices.

## Optional: Copilot descriptions

While a file is being read, each table and code block has a **Describe this table with Copilot** /
**Explain this code with Copilot** link above it. It sends **only that block** to a GitHub Copilot
model you choose, after a confirmation, and shows the suggested spoken description for you to review.
Nothing changes until you choose **Read Description**, and the link above the block switches back to
the original narration. Don't use it for content you are not allowed to share.

## Privacy

- Your documents are read on your computer. The natural voice and system voices never send text anywhere.
- The only network access is downloading the voice files you ask for, from a pinned revision on Hugging
  Face; each file's size and SHA-256 are verified before use. They are stored in VS Code's global
  storage. **AI Markdown Reader: Remove Downloaded Natural Voice** deletes them.
- Copilot descriptions are the only feature that sends text, only when you click the link.
- No telemetry. Raw HTML in documents is never rendered or run.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `aiMarkdownReader.engine` | `natural` | `natural` (Kokoro, local) or `system` |
| `aiMarkdownReader.naturalVoice` | `af_heart` | Natural voice |
| `aiMarkdownReader.naturalQuality` | `best` | `best` (326 MB) or `compact` (92 MB, slightly lower quality) |
| `aiMarkdownReader.systemVoice` | | Operating-system voice for the system engine |
| `aiMarkdownReader.rate` | `1` | Speed, in quarter steps from 0.25 to 5; pitch preserved |
| `aiMarkdownReader.expandedSpeeds` | `false` | Offer every quarter step from 0.25× to 5× instead of 0.5×, 1×, 1.5× and 2× |
| `aiMarkdownReader.volume` | `100` | Volume in percent; the player's slider changes it |
| `aiMarkdownReader.skipBackSeconds` / `skipForwardSeconds` | `10` / `30` | Skip lengths |
| `aiMarkdownReader.tableMode` | `rows` | `rows` or `columns` |
| `aiMarkdownReader.codeBlocks` | `announce` | `announce`, `read` or `skip` |
| `aiMarkdownReader.highlightWords` | `true` | Highlight each word as well as the sentence (editor and Read Aloud Preview) |
| `aiMarkdownReader.followInEditor` | `true` | Scroll the editor and the Read Aloud Preview to keep the reading in view |
| `aiMarkdownReader.replaceMarkdownPreview` | `true` | Show the Read Aloud Preview in place of VS Code's preview when reading starts from it |
| `aiMarkdownReader.pronunciations` | `{}` | Your pronunciation dictionary |
| `aiMarkdownReader.threads` | `0` | CPU threads for the natural voice (0 = automatic) |

The highlight colors are themable: `aiMarkdownReader.readingBackground` (sentence) and
`aiMarkdownReader.readingWordBackground` (word) in `workbench.colorCustomizations`.

## Troubleshooting

- **"Start reading" appears in the Read Aloud section.** VS Code requires one click or key press in it
  before sound can play, once per window. Press Space or click it.
- **The natural voice could not start.** The player says why and offers the system voice. Check that
  you installed the package for your platform.
- **The download fails behind a proxy.** VS Code's `http.proxy` settings apply. You can retry, or use
  the system voice meanwhile.
- **You edit the file while it is read.** Highlights stay on the right words, and the player offers
  **Update the reading** to hear your changes from the same place.

## Development

Requires Node.js 22. Set `ONNXRUNTIME_NODE_INSTALL=skip` before `npm ci` to avoid ONNX Runtime's
optional GPU downloads on Linux.

```sh
npm ci
npm run check                                       # type-check
npm test                                            # unit, document, engine and player tests
npx tsc && node tools/fetch-model.mjs .model        # pinned test model (92 MB)
CMR_MODEL_DIR=.model npm test                       # also run the real Kokoro model
node tools/smoke.mjs .model                         # bundled engine + this platform's runtime
node tools/e2e.mjs --code <VS Code executable> --model .model --quality compact
                                                    # real VS Code; add --mode gesture for a normal launch,
                                                    # --screenshots <dir> to capture the window
npm run package                                     # releases/*.vsix for all six platforms
```

`tools/e2e.mjs` works from WSL with the Windows `Code.exe`. It plays a document at 2× with the player
hidden and checks that the editor highlights the word being spoken, that playback never stalls more
than once, and that every track handoff is gapless. CI runs the unit and real-model tests and
the bundled-engine smoke test on Windows, macOS and Linux (x64 and Arm), then packages every platform.

For a hands-on check, [examples/wagyu.md](examples/wagyu.md) is a Shiba-themed master test file that
uses every Markdown feature the reader supports (the unit tests read it too), and
[examples/wagyu-checklist.md](examples/wagyu-checklist.md) walks through every control and what you
should hear and see.

To release, bump `version` in `package.json`, add a CHANGELOG entry and publish a GitHub release with
the packages from `npm run package`. Publishing the release runs
[publish.yml](.github/workflows/publish.yml), which tests, packages and publishes all six platforms to
the VS Code Marketplace with
[Trusted Publishing](https://github.com/microsoft/vscode-vsce#trusted-publishing) (no stored token).
New platform packages appear on the Marketplace only after Microsoft verifies them, which can take a
while. If a platform is still missing once verification is done, run the workflow again from the
Actions tab: it uploads only the platforms that are missing.

## License

The source code is [MIT](LICENSE). Packaged releases include eSpeak NG, which is GPL-3.0-or-later, so
each `.vsix` as a whole is distributed under GPL-3.0-or-later. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for all bundled components and the downloaded model.
