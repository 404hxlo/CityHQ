// Runs the dashboard without the desktop window: node server/standalone.js
import { startApp, stopApp } from './app.js';
import { getSettings } from './settings.js';

const { url } = await startApp();
console.log(`CityHQ is running at ${url}`);
console.log(`Passcode: ${getSettings().passcode}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await stopApp();
    process.exit(0);
  });
}
