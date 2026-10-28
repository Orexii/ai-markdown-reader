# Changelog

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
