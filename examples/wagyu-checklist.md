# Wagyu's verification checklist

Use this with [the Wagyu Field Guide](wagyu.md), the master test file. Tick each box as you go. Most
steps say what to do, then what should happen. The source of the field guide also has a hidden note
next to each feature (an HTML comment starting with "Check:") that says what you should hear.

## 1. Start reading

- [ ] Open `wagyu.md` and click the speaker icon in the editor title. The **Read Aloud** section opens
  in the Explorer; the first time in a window, click **Start reading** once.
- [ ] The first sentence is highlighted in the editor, and the word being spoken is highlighted more
  strongly. The highlight moves word by word, in time with the voice.
- [ ] The editor scrolls to keep the reading in view. Scroll far away: it stops following, and
  **Back to reading** appears in the status bar. Click it, or scroll back: it follows again.
- [ ] The status bar shows ↺ 10, play/pause with the time, 30 ↻ and the speed.

## 2. Keys in the Read Aloud player

Click an empty part of the **Read Aloud** section first, so it has keyboard focus.

- [ ] → goes to the next paragraph, ← to the start of this paragraph (press again for the one before).
  In the Quick facts table, → skips the whole table.
- [ ] Shift+→ and Shift+← move one sentence. In the table they move one row.
- [ ] Ctrl+→ goes forward 30 seconds and Ctrl+← back 10 seconds (Option instead of Ctrl on a Mac).
- [ ] Shift+↓ goes to the next heading, Shift+↑ to the start of this section, then the one before.
  Page Down and Page Up do the same.
- [ ] ↑ and ↓ change the volume; M mutes and unmutes.
- [ ] Space or K plays and pauses; J and L skip 10 and 30 seconds; - and + change the speed; Home
  goes back to the beginning.
- [ ] At the last paragraph, → says "This is the last paragraph" instead of doing nothing.

## 3. Buttons, speed and volume

- [ ] |◀ and ▶| skip by paragraph, and ↺ 10 and 30 ↻ skip by seconds.
- [ ] The speed menu offers 0.5×, 1×, 1.5× and 2×. **More speeds…** at the bottom of the menu lists every
  quarter step from 0.25× to 5×, and **Fewer speeds** goes back. The pitch stays natural at every speed.
- [ ] At 5×, the long sentence in Edge cases plays without stopping where it is split.
- [ ] Drag the thin volume slider, click a spot on it, and scroll over it. Click the speaker under it to
  mute; the slider greys out and keeps its level.
- [ ] The gear button shows the voice, table and code settings, word highlighting, following and
  More speeds.

## 4. What you should hear

- [ ] The front matter and the HTML comments are never read.
- [ ] Meet Wagyu: "8 to 11 kilograms", "100 percent", "12 dollars and 50 cents", "version 2 point 4
  point 1", "count Zoomies", "Shiba Zoom Tracker", "zoomies per day"; I O T, JSON and H T T P S are
  spelled out where needed.
- [ ] The mailing address is read one line at a time, with a short pause after each line.
- [ ] The table, quotes, alerts, numbered and nested lists, task list and tricks are read as the hidden
  notes describe.
- [ ] Code blocks are announced with their language and length; switch **Code blocks** to **Read
  aloud** in the gear menu and they are read line by line, then back to **Announce**.
- [ ] Images are read as "Image:" and their description.
- [ ] Links are read by their text, never their address. "Press Space to pause, or right arrow to skip
  to the next paragraph." The collapsed "details" block and the script are not read.
- [ ] "2 times 3 equals 6", and the emoji are silent.

## 5. Moving around in the editor

- [ ] Put the cursor on "Yellow" in the Quick facts table and press Ctrl+Alt+Enter (Read Aloud from
  Cursor): reading jumps to that row.
- [ ] Select the Meet Wagyu section, right-click and choose **Read Selection Aloud**: only the selection
  is read, then reading stops.
- [ ] While reading, type a word near the top of the file: the highlight stays on the right words, and
  the player offers **Update the reading**. Click it: reading continues from the same place with your
  change. Undo the edit afterwards.

## 6. The Read Aloud Preview

- [ ] Run **AI Markdown Reader: Open Read Aloud Preview to the Side** with `wagyu.md` open. It looks like
  VS Code's Markdown preview, with all five images (the remote one needs internet), checkboxes, the
  colored alerts and the collapsible details block. No alert box ever appears.
- [ ] While reading, the preview highlights the sentence and the spoken word, and scrolls along. Scroll
  away: **Back to reading** appears at the bottom. Click it.
- [ ] Table rows and code blocks are highlighted as a whole while they are read.
- [ ] Double-click a word to read from there. Right-click a word and choose **Read Aloud from Here**.
- [ ] Click inside the preview, then press → and Shift+→: they move by paragraph and sentence, as in
  the player. ↑, ↓, Space and Page Down still scroll the page.
- [ ] The Contents links scroll to each section; the Wikipedia link opens your browser; **the short
  demo** opens `demo.md`.
- [ ] Open VS Code's own preview (Ctrl+Shift+V) and press Play: the Read Aloud Preview takes its place
  and reading starts.

## 7. Settings and extras

- [ ] Gear menu, **Tables: Column by column**: the table is read one column at a time. Set it back.
- [ ] Turn off **Highlight each word**: only the sentence is highlighted. Turn it back on.
- [ ] Turn off **Keep the reading in view**: the editor no longer scrolls along. Turn it back on.
- [ ] Optional, with Copilot: click **Describe this table with Copilot** above the table, review the
  description, and choose **Read Description**. The link then offers the original narration again.
- [ ] Optional: **Use the system voice instead** in the gear menu reads with your system's voice, and
  **Use the natural voice** switches back.

## 8. Finish

- [ ] Click the stop button in the editor title: the highlights disappear and the player is empty.
- [ ] Open `wagyu.md` again and press Play: reading resumes where you stopped.

Good dog. 🐕
