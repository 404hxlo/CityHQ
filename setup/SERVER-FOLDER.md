# Your QBCore server

Everything for your server lives in this folder.

## Everyday use

Open **CityHQ** from your desktop. From there you can start, stop and restart the
server, manage resources, players and settings, browse every file, and make backups.

To play: open FiveM, press **F8**, and type `connect localhost:` followed by your game port.
The game port is in `qbcontrol.json` in this folder, and on the app's Overview page.

Closing the CityHQ window keeps it running in the tray, next to the clock, so backups,
scheduled restarts and alerts keep working. To quit, right-click the tray icon and choose **Quit**.
Neither of these stops the game server. Use **Stop** in the app to shut it down.

If the app ever won't open, `Start-Server.bat` starts the database and server without it.

## If the server won't start

Windows **Smart App Control** blocks one of the files FiveM's server needs. CityHQ tells
you when that is the reason. To fix it, open **Windows Security**, then **App & browser control**,
then **Smart App Control settings**, and turn it off.

## What's in this folder

| Item | Contents |
| --- | --- |
| `server\` | FiveM's server and txAdmin |
| `txData\` | Your server files, including `resources\` and `server.cfg` |
| `db\` | The private database and all its data. The **Backups** page protects this. |
| `control-app\` | CityHQ and its source code. The app itself is in `release\`. |
| `.qbcontrol\` | App settings, server backups, previous versions of edited files and removed resources |
| `logs\` | Startup logs |
| `tools\`, `downloads\` | Node.js for rebuilding the app, and installer files. Safe to delete `downloads\`. |
| `qbcontrol.json` | The ports this server uses |

## Moving to another drive or PC

Stop the server, quit CityHQ from the tray, then copy this whole folder. On the other
PC, open `control-app\release\CityHQ-win32-x64\CityHQ.exe` from the copy. The app
updates the settings that held the old location.

## Keep these private

Never share or upload `server.cfg` (it holds your FiveM license key), `.qbcontrol\` (the app's
passcode) or `db\` (your players' data).

## Rebuilding the app after changing its code

Open a Command Prompt in this folder, then run:

```
cd control-app
set PATH=%CD%\..\tools\node;%PATH%
npm run package
```
