import { BASIC_SPEEDS, formatSpeed } from './speeds';

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
  back: '<path d="M12 5V2L7 6l5 4V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/><text x="12" y="16.5" text-anchor="middle">%</text>',
  forward: '<path d="M12 5V2l5 4-5 4V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z"/><text x="12" y="16.5" text-anchor="middle">%</text>',
  previous: '<path d="M6 5h2v14H6zm3.5 7L18 19V5z"/>',
  next: '<path d="M16 5h2v14h-2zM6 5v14l8.5-7z"/>',
  settings: '<path d="M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3h-4l-.4 2.9a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.6 7.6 0 0 0 0 2l-2.2 1.6 2 3.5 2.5-1c.5.4 1.1.7 1.7 1L11 21h4l.4-2.9c.6-.3 1.2-.6 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/>',
  volumeHigh: '<path d="M3 9.5h4l5-4.5v14l-5-4.5H3z"/><path d="M15.5 9a4 4 0 0 1 0 6M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  volumeLow: '<path d="M3 9.5h4l5-4.5v14l-5-4.5H3z"/><path d="M15.5 9a4 4 0 0 1 0 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  volumeOff: '<path d="M3 9.5h4l5-4.5v14l-5-4.5H3z"/><path d="m16 9.5 5 5m0-5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
};

function icon(name: string, label = '', attributes = ''): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"${attributes ? ` ${attributes}` : ''}>${ICONS[name]!.replace('%', label)}</svg>`;
}

/** The volume control: a thin vertical slider styled like the progress bar, with the speaker under it to mute. */
function volumeMarkup(): string {
  const icons = `${icon('volumeHigh', '', 'data-level="high"')}${icon('volumeLow', '', 'data-level="low" hidden')}${icon('volumeOff', '', 'data-level="off" hidden')}`;
  return `<div id="volume-control" class="volume-control">
<div id="volume" class="volume-slider" role="slider" tabindex="0" aria-label="Volume" aria-orientation="vertical" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100" aria-valuetext="100%"><div id="volume-track" class="volume-track"><div class="volume-fill"></div></div><div class="volume-thumb"></div></div>
<button id="mute" class="mute" title="Mute (M)" aria-label="Mute" aria-pressed="false">${icons}</button>
</div>`;
}

/** The compact player shown in the Read Aloud view. The text itself is highlighted in the editor. */
export function playerMarkup(options: MarkupOptions): string {
  // The player replaces these with the current list (and the More speeds toggle) once it starts.
  const speeds = BASIC_SPEEDS.map(speed => `<option value="${speed}"${speed === 1 ? ' selected' : ''}>${formatSpeed(speed)}</option>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${options.cspSource} data:; style-src ${options.cspSource}; script-src 'nonce-${options.nonce}'; media-src blob:;">
<link href="${options.css}" rel="stylesheet"><title>Read Aloud</title></head>
<body>
<div id="setup" class="setup" hidden></div>
<div id="stale" class="notice" hidden><span id="stale-text">The file changed.</span> <button id="refresh" class="link-button">Update the reading</button></div>
<div id="start" class="start" hidden>
<button id="start-button" class="primary-button start-button">${icon('play')}<span>Start reading</span></button>
<p>VS Code needs one click here before it can play sound. After that, use the controls anywhere.</p>
</div>
<main class="player" aria-label="Player">
<div class="deck">
<div class="transport">
<p id="section" class="section"></p>
<div class="timeline"><input id="seek" type="range" min="0" max="1" step="0.1" value="0" aria-label="Position"><div id="chapters" class="chapters" aria-hidden="true"></div></div>
<div class="times"><span id="elapsed"></span><span id="remaining"></span></div>
<div class="controls">
<div class="buttons">
<button id="previous" class="icon" title="Previous paragraph (Shift+↑)" aria-label="Previous paragraph">${icon('previous')}</button>
<button id="back" class="icon" title="Back ${options.skipBack} seconds (← or J)" aria-label="Back ${options.skipBack} seconds">${icon('back', String(options.skipBack))}</button>
<button id="play" class="icon primary" title="Play (Space)" aria-label="Play">${icon('play')}</button>
<button id="forward" class="icon" title="Forward ${options.skipForward} seconds (→ or L)" aria-label="Forward ${options.skipForward} seconds">${icon('forward', String(options.skipForward))}</button>
<button id="next" class="icon" title="Next paragraph (Shift+↓)" aria-label="Next paragraph">${icon('next')}</button>
</div>
<div class="extras">
<select id="rate" class="rate" title="Speed (- / +)" aria-label="Speed">${speeds}</select>
<button id="more" class="icon" title="Reading settings" aria-label="Reading settings" aria-expanded="false">${icon('settings')}</button>
</div>
</div>
<p id="status" class="status" role="status" aria-live="polite"></p>
</div>
${volumeMarkup()}
</div>
<div id="settings" class="settings" hidden>
<label>Voice <select id="voice"></select></label>
<label>Tables <select id="table-mode"><option value="rows">Row by row</option><option value="columns">Column by column</option></select></label>
<label>Code blocks <select id="code-blocks"><option value="announce">Announce</option><option value="read">Read aloud</option><option value="skip">Skip</option></select></label>
<label class="check"><input id="words" type="checkbox"> Highlight each word</label>
<label class="check"><input id="follow" type="checkbox"> Keep the reading in view</label>
<label class="check"><input id="more-speeds" type="checkbox"> More speeds (0.25× to 5×)</label>
<button id="engine-switch" class="link-button"></button>
</div>
</main>
<script nonce="${options.nonce}" src="${options.script}"></script>
</body></html>`;
}
