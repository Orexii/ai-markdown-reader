# Changelog

## 0.8.2

- **→ and ← move through a table one row at a time.** They used to skip a whole table at once, as did
  the |◀ ▶| buttons and the previous and next track keys. Now the first press goes to the table's
  introduction (how many rows and which columns), then each press moves one row, even when a long
  row is read in parts. When reading by column, each press moves one column.

## 0.8.1

- **The Read Aloud button in a preview reads in the preview.** The speaker button in the title bar of a
  Markdown preview used to open the source file and read it there. Now it reads in the Read Aloud
  Preview, highlighting each word. This works from the Read Aloud Preview and from VS Code's own preview,
  which the Read Aloud Preview replaces. Read Aloud from the Explorer still opens a file in the editor
  if the file is not already showing.

## 0.8.0

- **On the VS Code Marketplace** as `orexii.ai-markdown-reader`: search for **AI Markdown Reader** in the
  Extensions view. VS Code installs the right package for your computer and keeps it up to date.
- **The ID now matches the name.** Settings, commands and theme colors moved from `clearMarkdown.*` to
  `aiMarkdownReader.*`. Your settings and the downloaded voice move over automatically the first time
  AI Markdown Reader starts, so the voice is not downloaded again. Uninstall Clear Markdown Reader
  (`orexii.clear-markdown-reader`) afterwards. If you had moved the Read Aloud view, move it again once.

## 0.7.0

- **Arrow keys move through the text.** In the player, ← / → go to the previous / next paragraph (like the
  |◀ ▶| buttons), Shift+← / Shift+→ by sentence, and Shift+↑ / Shift+↓ (or Page Up / Page Down) by
  section. Ctrl+← / Ctrl+→ (Option on macOS) skip 10 / 30 seconds, as do J / L and the ↺ 10 / 30 ↻
  buttons. ↑ / ↓ still change the volume. The same keys work in the Read Aloud Preview while its file
  is being read. New commands: **Previous Section** and **Next Section**.
- **Better pronunciation:** percentages ("100 percent"), units after numbers ("8 kilograms",
  "100 gibibytes", "250 milliseconds"), keyboard shortcuts ("control plus right arrow"), arrows inside
  `<kbd>`, multiplication ("2 times 3"), and a pause at hard line breaks, so addresses and poems are
  read line by line.
- **A master test file:** `examples/wagyu.md`, a Shiba-themed tour of every Markdown feature, with
  `examples/wagyu-checklist.md` to verify each control by hand. The unit tests read it too.

## 0.6.0

- **New name: AI Markdown Reader - Read Aloud**, and an icon: Wagyu, a red Shiba Inu, reading a
  Markdown page aloud. Commands are now under **AI Markdown Reader** in the Command Palette. Settings,
  keybindings and the downloaded voice are unchanged.
- **A shorter speed menu.** It offers 0.5×, 1×, 1.5× and 2×. **More speeds…** at the bottom of the menu,
  **More speeds** in the player settings, or `clearMarkdown.expandedSpeeds` offer every quarter step
  from 0.25× to 5×. A speed you already use stays available until you change it.

## 0.5.0

- **Read from the rendered preview.** A new **Read Aloud Preview** looks like VS Code's Markdown preview
  and highlights the sentence and the spoken word as they are read, scrolling along with **Back to
  reading**. Double-click a word, or right-click and choose **Read Aloud from Here**, to read from
  there. It updates as you edit, and opens from the command palette, **Reopen Editor With…** or the
  Explorer.
- **Play works from VS Code's own Markdown preview.** It reads that file and, because VS Code's preview
  cannot show the reading position, shows the Read Aloud Preview in its place
  (`clearMarkdown.replaceMarkdownPreview` turns that off).
- **Speeds up to 3×**, in quarter steps from 0.5×.

## 0.4.2

- **Paragraph buttons.** The |◀ and ▶| buttons now skip to the previous and next paragraph (list
  items, headings and tables count as paragraphs), as do headset and keyboard previous/next track
  keys. Previous goes to the start of the current paragraph first. Sentence steps stay on Shift+← /
  Shift+→. The buttons stay visible in narrow sidebars: speed and settings move to a second row
  instead.
- **A thin volume slider** that matches the progress bar, with the speaker under it, level with the
  play controls.

## 0.4.1

- **A cleaner player.** The volume is now a rounded vertical pill on the right that fills from the
  bottom in the accent color, with the speaker inside it to mute and the level shown on hover. The
  controls always stay on one row (narrow sidebars drop the sentence buttons), the played part of the
  progress bar is filled, the empty player shows a one-line hint, and the view no longer needs a
  scrollbar. High contrast themes use their contrast color for the fills.

## 0.4.0

- **Vertical volume slider** on the right of the Read Aloud player, with a mute button under it. Drag
  it, scroll over it, or use ↑ / ↓ and M while the player has focus. The slider follows perceived
  loudness, so its middle sounds about half as loud, and the level is remembered in
  `clearMarkdown.volume`.

## 0.3.0

- **No more separate reader page.** The text is highlighted in your own Markdown editor: the sentence
  being read, and the word being spoken more strongly. The editor scrolls along, stops following when
  you scroll away, and follows again when you scroll back or click **Back to reading**.
- **Small controls.** Back 10 s, play/pause with time, forward 30 s and speed in the status bar;
  pause/resume and stop in the editor title; a compact **Read Aloud** section in the Explorer hosts the
  audio (VS Code needs one click there per window before sound can play) and can be collapsed while
  reading continues.
- **No more hitches between sentences.** Consecutive sentences now play as one continuous track, and
  the next track is preloaded and started inside the closing pause of the current one, so sentence
  ends no longer stop for a moment. Speech generation adapts to how much audio is buffered, so 2× does
  not run out of audio after starting or skipping.
- **Speeds in quarter steps:** 0.5×, 0.75×, 1×, 1.25×, 1.5×, 1.75× and 2×.
- **Read Aloud from Cursor** jumps to the word under the cursor while a file is being read.
- Copilot descriptions are offered above tables and code blocks of the file being read, and reviewed
  in a dialog before use.
- Editing the file while it is read keeps highlights on the right words and offers to update the
  reading from the same place.

## 0.2.0

- **Natural local voice by default.** Kokoro-82M runs on your computer through ONNX Runtime in a
  separate process, after a one-time, verified download (326 MB, or 92 MB compact). 28 English voices;
  system voices remain available.
- **Follow-along reader.** The document is shown as rendered Markdown with the current sentence and word
  highlighted, auto-scroll with **Back to reading**, click any word to read from there, and the lines
  being read highlighted in the editor.
- **Podcast-style controls.** Back 10 s / forward 30 s (configurable), previous/next sentence and
  paragraph, a scrubber with heading markers and time left, speeds from 0.5× to 3× with pitch preserved,
  keyboard shortcuts, a status-bar control, media keys where supported, and resume where you left off.
- **Better narration.** Tables announce their columns and highlight each cell and header as it is read;
  callouts, task lists and code blocks get short cues; acronyms, identifiers, numbers, money, times and
  versions are pronounced naturally; add your own words with `clearMarkdown.pronunciations`.
- **Copilot, per block.** Describe a table or explain a code block with Copilot, review it, and choose
  whether to use it. Only that block is sent.
- One reader panel is reused across documents, so after the first click (required by VS Code before
  sound) later documents start immediately.
- Separate packages for Windows, macOS and Linux on x64 and Arm.

## 0.1.0

- First release: structure-aware narration of Markdown with system voices and optional Copilot rewriting.
