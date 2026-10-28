export interface MarkupOptions {
  cspSource: string;
  nonce: string;
  css: string;
  script: string;
  skipBack: number;
  skipForward: number;
}

const ICONS: Record<string, string> = {
  play: '<path d="M8 5v14l11-7z"/>',
  pause: '<path d="M7 5h4v14H7zm6 0h4v14h-4z"/>',
  back: '<path d="M12 5V2L7 6l5 4V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/><text x="12" y="16.5" text-anchor="middle">%</text>',
  forward: '<path d="M12 5V2l5 4-5 4V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z"/><text x="12" y="16.5" text-anchor="middle">%</text>',
  previous: '<path d="M6 5h2v14H6zm3.5 7L18 19V5z"/>',
  next: '<path d="M16 5h2v14h-2zM6 5v14l8.5-7z"/>',
  settings: '<path d="M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3h-4l-.4 2.9a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.6 7.6 0 0 0 0 2l-2.2 1.6 2 3.5 2.5-1c.5.4 1.1.7 1.7 1L11 21h4l.4-2.9c.6-.3 1.2-.6 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/>'
};

function icon(name: string, label = ''): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name]!.replace('%', label)}</svg>`;
}

/** The reader webview's HTML shell; the document itself arrives later in a "plan" message. */
export function readerMarkup(options: MarkupOptions): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${options.cspSource} data:; style-src ${options.cspSource}; script-src 'nonce-${options.nonce}'; media-src blob:;">
<link href="${options.css}" rel="stylesheet"><title>Clear Markdown Reader</title></head>
<body>
<div id="banner" class="banner" hidden></div>
<main id="doc" class="doc" aria-label="Document"></main>
<button id="back-to-reading" class="pill" hidden>Back to reading</button>
<div id="start" class="start" hidden>
<button id="start-button" class="start-button">${icon('play')}<span>Start listening</span></button>
<p>VS Code lets the reader play sound after one click or key press in this panel. Press Space or click to start.</p>
</div>
<div id="shortcuts" class="overlay" role="dialog" aria-label="Keyboard shortcuts" hidden>
<h2>Keyboard shortcuts</h2>
<dl>
<dt>Space or K</dt><dd>Play or pause</dd>
<dt>← or J</dt><dd>Back ${options.skipBack} seconds</dd>
<dt>→ or L</dt><dd>Forward ${options.skipForward} seconds</dd>
<dt>Shift+← / Shift+→</dt><dd>Previous / next sentence</dd>
<dt>Shift+↑ / Shift+↓</dt><dd>Previous / next paragraph</dd>
<dt>- / +</dt><dd>Slower / faster</dd>
<dt>Home</dt><dd>Back to the start</dd>
<dt>F</dt><dd>Follow the voice</dd>
<dt>Click</dt><dd>Read from that word</dd>
<dt>Alt+Click</dt><dd>Show the line in the editor</dd>
<dt>Ctrl/Cmd+Click</dt><dd>Open a link</dd>
</dl>
<button id="close-shortcuts">Close</button>
</div>
<footer id="player" class="player" aria-label="Player">
<div class="timeline">
<span id="elapsed" class="time">0:00</span>
<div class="track"><input id="seek" type="range" min="0" max="1" step="0.1" value="0" aria-label="Position"><div id="chapters" class="chapters"></div></div>
<span id="remaining" class="time">-0:00</span>
</div>
<div class="controls">
<div class="group">
<button id="previous" class="icon" title="Previous sentence (Shift+←)" aria-label="Previous sentence">${icon('previous')}</button>
<button id="back" class="icon" title="Back ${options.skipBack} seconds (← or J)" aria-label="Back ${options.skipBack} seconds">${icon('back', String(options.skipBack))}</button>
<button id="play" class="icon primary" title="Play (Space)" aria-label="Play">${icon('play')}</button>
<button id="forward" class="icon" title="Forward ${options.skipForward} seconds (→ or L)" aria-label="Forward ${options.skipForward} seconds">${icon('forward', String(options.skipForward))}</button>
<button id="next" class="icon" title="Next sentence (Shift+→)" aria-label="Next sentence">${icon('next')}</button>
</div>
<div class="group">
<button id="rate" class="text" title="Speed (- / +)" aria-label="Playback speed">1×</button>
<select id="voice" aria-label="Voice" title="Voice"></select>
<button id="settings" class="icon" title="Reader settings" aria-label="Reader settings" aria-expanded="false">${icon('settings')}</button>
</div>
</div>
<p id="status" class="status" role="status" aria-live="polite"></p>
<div id="speed-menu" class="menu" role="menu" hidden></div>
<div id="settings-menu" class="menu settings" hidden>
<label>Tables <select id="table-mode"><option value="rows">Row by row</option><option value="columns">Column by column</option></select></label>
<label>Code blocks <select id="code-blocks"><option value="announce">Announce</option><option value="read">Read aloud</option><option value="skip">Skip</option></select></label>
<label class="check"><input id="follow" type="checkbox" checked> Follow the voice</label>
<label class="check"><input id="words" type="checkbox"> Highlight words</label>
<label class="check"><input id="editor-follow" type="checkbox"> Highlight in the editor</label>
<div class="menu-actions"><button id="engine-switch" class="link-button"></button><button id="show-shortcuts" class="link-button">Keyboard shortcuts (?)</button></div>
</div>
</footer>
<script nonce="${options.nonce}" src="${options.script}"></script>
</body></html>`;
}
