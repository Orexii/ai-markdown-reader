# Changelog

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
