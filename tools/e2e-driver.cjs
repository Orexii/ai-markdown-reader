// Launches VS Code through Playwright so the test can click inside the reader webview with a
// real (trusted) input event, which VS Code requires before a webview may play sound.
const { _electron } = require('playwright-core');

(async () => {
  const [executablePath, ...args] = JSON.parse(process.argv[2]);
  // The driver itself runs as Node via ELECTRON_RUN_AS_NODE; VS Code must not inherit that.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE'));
  const app = await _electron.launch({ executablePath, args, env, timeout: 180_000 });
  const child = app.process();
  child.stdout?.on('data', data => process.stdout.write(data));
  child.stderr?.on('data', data => process.stdout.write(data));
  let closed = false;
  app.on('close', () => { closed = true; });
  const window = await app.firstWindow();
  let clicks = 0;
  while (!closed) {
    for (const frame of window.frames()) {
      try {
        const button = frame.locator('#start-button');
        if (await button.isVisible({ timeout: 50 })) {
          await button.click({ timeout: 2000 });
          clicks++;
          console.log('E2E: clicked Start listening inside the webview');
        }
      } catch {
        // Frames come and go while VS Code starts and closes.
      }
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
