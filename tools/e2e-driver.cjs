// Launches VS Code through Playwright so the test can click inside the reader webview with a
// real (trusted) input event, which VS Code requires before a webview may play sound.
const { _electron } = require('playwright-core');

(async () => {
  const [executablePath, ...args] = JSON.parse(process.argv[2]);
  const screenshots = process.argv[3];
  // The driver itself runs as Node via ELECTRON_RUN_AS_NODE; VS Code must not inherit that.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE'));
  const app = await _electron.launch({ executablePath, args, env, timeout: 180_000 });
  const child = app.process();
  // The test asks for clicks it cannot make through the API with a line "E2E-CLICK title <id> [<button label>]":
  // a button in the active editor's title bar, which VS Code runs with that editor's file.
  const requests = [];
  const seen = new Set();
  let partial = '';
  const output = data => {
    process.stdout.write(data);
    const lines = (partial + data).split(/\r?\n/);
    partial = lines.pop();
    for (const line of lines) {
      const request = /E2E-CLICK title (\d+) \[([^\]]+)\]/.exec(line);
      if (request && !seen.has(request[1])) {
        seen.add(request[1]);
        requests.push(request[2]);
      }
    }
  };
  child.stdout?.on('data', output);
  child.stderr?.on('data', output);
  let closed = false;
  app.on('close', () => { closed = true; });
  const window = await app.firstWindow();
  let clicks = 0;
  let shots = 0;
  let lastShot = Date.now();
  while (!closed) {
    while (requests.length) {
      const label = requests.shift();
      try {
        await window.locator(`.editor-group-container.active .editor-actions .action-label[aria-label^="${label}"]`).first().click({ timeout: 15_000 });
        console.log(`E2E: clicked ${label} in the editor title bar`);
      } catch (error) {
        console.log(`E2E: could not click ${label} in the editor title bar: ${error.message.split('\n')[0]}`);
      }
    }
    for (const frame of window.frames()) {
      try {
        const button = frame.locator('#start-button');
        if (await button.isVisible({ timeout: 50 })) {
          await button.click({ timeout: 2000 });
          clicks++;
          console.log('E2E: clicked Start inside the player');
        }
      } catch {
        // Frames come and go while VS Code starts and closes.
      }
    }
    if (screenshots && Date.now() - lastShot > 3000) {
      lastShot = Date.now();
      await window.screenshot({ path: `${screenshots}/shot-${String(++shots).padStart(2, '0')}.png` }).catch(() => undefined);
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  await new Promise(resolve => (child.exitCode === null ? child.once('exit', resolve) : resolve()));
  console.log(`E2E: VS Code exited with code ${child.exitCode} after ${clicks} click(s).`);
  process.exit(child.exitCode ?? 1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
