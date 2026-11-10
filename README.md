# CityHQ

**Headquarters for your QBCore roleplay city.** Start it, watch it, fix it and back it up from one place.

CityHQ is a Windows app for running a QBCore FiveM server without touching config files or the
command line. It sits on top of txAdmin and works from the desktop, or from a phone on the same Wi-Fi.

The setup script creates a complete server in one folder: FiveM's server, a private database
and this app. Nothing is installed into Windows, and other servers on the PC are left alone.

## What it does

- **Overview:** start, stop and restart the server, with live CPU, memory and player counts.
- **Problems in plain English:** what broke, which resource caused it, how to fix it, and a
  button that opens the exact line.
- **Resources:** start, stop, add (from a file, a folder or GitHub, including files over 1 GB)
  and remove resources. Missing dependencies can be installed with one click when the source is known.
- **Files:** browse and edit any server file. Lua is checked before saving, and every save can be undone.
- **Players:** money, jobs, gangs, items, messages, revive, kick and ban.
- **Backups:** one-click backup and restore of players, settings and scripts, plus a nightly backup.
- **Safety net:** if a resource fails after an edit, the app offers to undo it. If the server
  crashes, the app restarts it and tells you. Scheduled restarts warn players first.

## What you need

- Windows 10 or 11, 64-bit
- About 4 GB of free disk space
- A free FiveM license key from <https://portal.cfx.re> (txAdmin asks for it)
- **Smart App Control turned off.** It blocks an unsigned file inside FiveM's own server, so no
  FiveM server can start while it is on. Check it under Windows Security, then App & browser
  control, then Smart App Control settings.

## Install on a new PC

1. On this page choose **Code**, then **Download ZIP**.
2. Right-click the ZIP, choose **Properties**, tick **Unblock**, and press OK. Then extract it.
3. Double-click **Setup.cmd** and answer its two questions. Choose a folder with no spaces in
   its path, such as `C:\QBCore-Server`.
4. txAdmin opens in your browser, and a black window shows the PIN it asks for. Create your
   account, then choose **Popular Recipes**, then **QBCore Framework**.
5. For the database, enter host `127.0.0.1`, the port setup printed (normally `3308`), user
   `root`, and leave the password empty.
6. When txAdmin says the server is running, close the black window. Open **CityHQ** from
   your desktop and press **Start**. Use the app from then on.

Setup downloads FiveM's server from fivem.net, MariaDB from mariadb.org and Node.js from
nodejs.org, and checks the last two against their published checksums. If it stops part way,
run it again and it continues.

If Windows says the app is from an unknown publisher, choose **More info**, then **Run anyway**.
The app is not code-signed. Windows Firewall may also ask about FiveM's server the first time
it starts. Allow it on private networks if friends on your Wi-Fi should be able to join.

## Moving an existing server to another PC

GitHub is for the app, not for your server. To move a server, stop it, quit CityHQ from
the tray, and copy the whole server folder to the other PC, for example on a USB drive. Open the
app from the copy and it corrects the settings that held the old location.

## Keep these out of GitHub

A server folder holds things that must stay private. None of them are in this repository, and
`.gitignore` blocks the obvious ones in case they are ever copied in:

- `server.cfg`: your FiveM license key
- `.qbcontrol\`: the app's passcode and access key
- `db\`: your players' data
- paid resources: sharing them usually breaks their license

## If txAdmin's QBCore recipe fails to download

Some networks get errors from GitHub while txAdmin downloads the recipe. `setup\qbcore-bundle.mjs`
downloads the same official recipe with retries and serves it to txAdmin from your own PC. The
steps are at the top of that file.

## Working on the app

```
npm ci
npm test
npm run package
```

`npm run package` builds the app into `release\`. The app manages the server folder it sits in:
it looks upward from where it is installed for a folder containing `qbcontrol.json` or
`server\FXServer.exe`. Set the `QBC_ROOT` environment variable to point it somewhere else.

| Folder | Contents |
| --- | --- |
| `electron\` | The desktop window and tray icon |
| `server\` | The local web server the app and phone dashboard talk to |
| `web\` | The screens (React) |
| `agent-resource\qb-control\` | A small resource the app adds to the server so it can talk to the game |
| `setup\` | The setup script and the guide it copies into each server folder |

## Not affiliated

This is an independent project. It is not made or endorsed by Cfx.re, Rockstar Games, txAdmin
or the QBCore Framework.
