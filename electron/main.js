// The desktop window. The server runs on its own, so closing this never stops the game.
import {
  app, BrowserWindow, dialog, Menu, nativeImage, screen, session, shell, Tray,
} from 'electron';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp, stopApp } from '../server/app.js';
import { COOKIE, createSession } from '../server/auth.js';
import { isSecondary, setDesktopHooks } from '../server/desktop.js';
import { onEvent } from '../server/events.js';
import { APP_PORT, LOG_DIR } from '../server/paths.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const iconPath = path.join(here, '..', 'build', 'icon.png');
const EXTERNAL = /^(https?:|fivem:)/i;
const AUTOSTART_FLAG = '--autostart';

let win = null;
let tray = null;
let baseUrl = null;
let quitting = false;
let trayHintShown = false;

const startedHidden = () => process.argv.includes(AUTOSTART_FLAG);

function logError(...args) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(path.join(LOG_DIR, 'control-app.log'), `${new Date().toISOString()} ${args.join(' ')}\n`);
  } catch { /* logging must never crash the app */ }
}
const originalError = console.error;
console.error = (...args) => { logError(...args.map(String)); originalError(...args); };
process.on('uncaughtException', (err) => logError('uncaught', err.stack || err));
process.on('unhandledRejection', (err) => logError('unhandled', err?.stack || err));

async function signIn() {
  await session.defaultSession.cookies.set({
    url: baseUrl,
    name: COOKIE,
    value: createSession(),
    httpOnly: true,
    sameSite: 'strict',
    expirationDate: Date.now() / 1000 + 30 * 24 * 60 * 60,
  });
}

function showWindow() {
  // Opening the app a second time during startup: the first window is about to appear anyway.
  if (!baseUrl) return undefined;
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return undefined;
}

/**
 * The window must fit the screen it opens on. Laptops with display scaling (200% on a
 * 2560 x 1600 screen works like 1280 x 800) are smaller than the size the app prefers.
 */
function windowSize() {
  const area = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1320, area.width);
  const height = Math.min(860, area.height);
  // On a small screen, use all of it rather than leaving a sliver of desktop around the edges.
  const fill = area.width <= 1440 || area.height <= 900;
  return {
    width, height, fill, minWidth: Math.min(420, area.width), minHeight: Math.min(560, area.height),
  };
}

function createWindow() {
  const size = windowSize();
  win = new BrowserWindow({
    width: size.width,
    height: size.height,
    minWidth: size.minWidth,
    minHeight: size.minHeight,
    center: true,
    title: 'CityHQ',
    backgroundColor: '#0a0b11',
    autoHideMenuBar: true,
    icon: iconPath,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.once('ready-to-show', () => {
    if (size.fill && !isSecondary()) win.maximize();
    if (startedHidden()) return;
    // A test copy must never pull focus away from someone playing the game.
    if (isSecondary()) win.showInactive();
    else win.show();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (EXTERNAL.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(baseUrl)) return;
    event.preventDefault();
    if (EXTERNAL.test(url)) shell.openExternal(url);
  });
  win.on('close', (event) => {
    // Stay in the tray so backups, scheduled restarts, alerts and phone access keep working.
    if (!quitting) {
      event.preventDefault();
      win.hide();
      if (!trayHintShown) {
        trayHintShown = true;
        tray?.displayBalloon?.({
          title: 'CityHQ is still running',
          content: 'Backups, restarts and alerts keep working. Right-click the tray icon to quit.',
        });
      }
    }
  });
  win.on('closed', () => { win = null; });
  win.loadURL(baseUrl);
}

function createTray() {
  // A simpler drawing made for 16 pixels, plus a sharper one for high-resolution screens.
  const image = nativeImage.createFromPath(path.join(here, '..', 'build', 'tray-16.png'));
  image.addRepresentation({ scaleFactor: 2, buffer: readFileSync(path.join(here, '..', 'build', 'tray-32.png')) });
  tray = new Tray(image);
  tray.setToolTip('CityHQ');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open CityHQ', click: showWindow },
    { type: 'separator' },
    { label: 'Quit (the game server keeps running)', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
  tray.on('balloon-click', showWindow);
}

function installDesktopHooks() {
  const loginOptions = { path: process.execPath, args: [AUTOSTART_FLAG] };
  setDesktopHooks({
    getOpenAtLogin: () => (app.isPackaged ? app.getLoginItemSettings(loginOptions).openAtLogin : false),
    setOpenAtLogin(enabled) {
      // A development copy must never register itself to run at startup.
      if (!app.isPackaged) return;
      app.setLoginItemSettings({ ...loginOptions, openAtLogin: enabled });
    },
    openFolder: (folder) => shell.openPath(folder),
    async pickInstallSource(type) {
      const options = type === 'folder'
        ? { title: 'Choose a resource folder', properties: ['openDirectory'] }
        : { title: 'Choose a resource file', properties: ['openFile'], filters: [{ name: 'Archives', extensions: ['zip', 'rar', '7z'] }] };
      const parent = win && !win.isDestroyed() ? win : undefined;
      const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
      return result.canceled ? null : result.filePaths[0];
    },
  });
  if (!isSecondary()) {
    onEvent((event) => {
      if (event.level === 'alert') tray?.displayBalloon?.({ title: event.title, content: event.detail || 'Open CityHQ for details.' });
    });
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  Menu.setApplicationMenu(null);
  app.on('second-instance', showWindow);
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => {
    if (quitting) app.quit();
  });
  app.on('will-quit', () => { stopApp().catch(() => {}); });

  app.whenReady().then(async () => {
    installDesktopHooks();
    try {
      ({ url: baseUrl } = await startApp());
    } catch (err) {
      logError('startup', err.stack || err);
      dialog.showErrorBox(
        'CityHQ could not start',
        err.code === 'EADDRINUSE'
          ? `Port ${APP_PORT} is already in use. Close any other copy of CityHQ and try again.`
          : String(err.message || err),
      );
      quitting = true;
      app.quit();
      return;
    }
    // The page comes from this PC, so there is nothing to gain from keeping an old copy.
    await session.defaultSession.clearCache().catch(() => {});
    await signIn();
    createTray();
    createWindow();
  });
}
