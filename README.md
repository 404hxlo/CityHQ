# CityHQ

**Headquarters for your QBCore or Qbox roleplay city.** Start it, watch it, fix it and back it up from one place.

CityHQ is a Windows app for running a QBCore or Qbox FiveM server without touching config files or
the command line. It works with the server you already have, or builds you a new one. It sits on top
of txAdmin and works from the desktop, or from a phone on the same Wi-Fi.

Website: <https://404hxlo.github.io/CityHQ/>

## Download

### [⬇ Download CityHQ for Windows](https://github.com/404hxlo/CityHQ/releases/latest/download/CityHQ-windows.zip)

That link always gets the newest version (**CityHQ-windows.zip**). Don't use GitHub's green **Code**
button: it downloads **CityHQ-main.zip**, which is the source code and has no app in it.

1. In your Downloads, right-click **CityHQ-windows.zip**, choose **Properties**, tick **Unblock** and
   press OK. Then right-click it again and choose **Extract All**. (It won't run from inside the zip.)
2. Open the extracted **CityHQ-windows** folder, then the **CityHQ** folder inside it.
3. Double-click **CityHQ**: the one with the purple HQ icon (its type is Application; Windows hides
   the `.exe`). If Windows says it protected your PC, choose **More info**, then **Run anyway**. The
   app isn't code-signed, so Windows doesn't know it yet.

The first time, CityHQ asks: **Do you already have a FiveM server?**

- **Yes, I have one.** CityHQ looks for FiveM servers on your PC and shows what it found: where
  FXServer and txAdmin are, the ports, and the database from your `server.cfg` (XAMPP, MySQL or
  MariaDB). It points out anything missing, in plain English. When you connect, it adds its small
  helper script (`qb-control`) and a few marked lines to `server.cfg`, and downloads the official
  MariaDB tools once (for backups). Nothing else in your server changes.
- **No, make me one.** You choose QBCore or Qbox, and CityHQ builds a new server in one folder:
  FiveM's server and a private database that only your PC can reach. Then it starts txAdmin, shows
  its PIN, and tells you exactly which recipe to choose.

- **It's hosted.** For a server rented from a host such as RocketNode. Connect with your panel's API
  key (Pterodactyl-style panels: **Account**, then **API Credentials**) or with SFTP. CityHQ adds its
  helper to the server, which starts at the server's next restart. Your key stays on your PC, locked
  with Windows' own protection. Health, Problems, Backups (your host's own, plus a database copy on
  your PC) and installing scripts work for hosted servers too. A few things stay PC-only: the
  install check, running .sql files, and the restart explanations.

You can switch to a different server later under **Settings**, then **Change server**. To move a
server from your PC to a host, use **Settings**, then **Move to a host**: CityHQ uploads every
resource (maps and cars included), the database and server.cfg, and picks up where it stopped if the
connection drops.

## What you need

- Windows 10 or 11, 64-bit
- A QBCore or Qbox server run with txAdmin (on this PC or at a host), or about 4 GB of free space for a new one
- For a new server, a free FiveM license key from <https://portal.cfx.re> (txAdmin asks for it)
- **Smart App Control turned off.** It blocks an unsigned file inside FiveM's own server, so no
  FiveM server can start while it is on. Check it under Windows Security, then App & browser
  control, then Smart App Control settings.

## What it does

- **Home:** your server's command centre. Type what you want in plain words ("kick a player", "make it
  rain", "add a script") or click a suggestion; everything you do shows up as a block, next to the live
  log and a panel with players, load and anything to fix. Ctrl K brings the same box up on any page.
- **Simple and Pro:** Simple (the default) uses forms, plain words and starting points. Pro shows command
  syntax, the raw log and the console, and runs anything else you type as a server command.
- **Stats:** players, CPU and memory over time, and a calendar of backups and restarts.
- **Health:** checks for common setup problems (sleep, missing tables, start-order traps), explains
  every restart, and helps friends outside your home join.
- **Problems in plain English:** what broke, which resource caused it, how to fix it, a link to that
  script's own documentation, and a one-click fix when one is safe.
- **Resources:** start, stop, add (from a file, a folder or GitHub, including files over 1 GB) and
  remove resources, each with an install check of what it needs.
- **Files:** browse and edit any server file. Lua is checked before saving, and every save can be undone.
- **City and Players:** weather, announcements, the whitelist, money, jobs, items, revive, kick and ban.
- **Backups:** one-click backup and restore of players, settings and scripts, plus a nightly backup,
  and a list of every change made through CityHQ with Undo.
- **Safety net:** if the server crashes, on your PC or at a host, CityHQ tells you why: a Windows
  notification, a message in your Discord channel if you like, and the cause with its fix (a button
  when switching something off fixes it) in Things to fix. It restarts the server if it stays down.
  Scheduled restarts warn players first, and the PC is kept awake while the server runs.

## Moving a server to another PC

GitHub is for the app, not for your server. To move a server, stop it, quit CityHQ from the tray,
and copy the whole server folder to the other PC, for example on a USB drive. Then open CityHQ there
and choose that folder.

## Keep these out of GitHub

A server folder holds things that must stay private. None of them are in this repository, and
`.gitignore` blocks the obvious ones in case they are ever copied in:

- `server.cfg`: your FiveM license key and database password
- `.qbcontrol\`: the app's passcode and access key
- `db\`: your players' data
- paid resources: sharing them usually breaks their license

## Other ways to set up

`Setup.cmd` (in the source download) builds a new server folder with the app inside it, the way
CityHQ's "make me one" does, but from a command window. If txAdmin's QBCore recipe fails to
download on your network, `setup\qbcore-bundle.mjs` downloads the same official recipe with retries
and serves it to txAdmin from your own PC; the steps are at the top of that file.

## Working on the app

```
npm ci
npm test
npm run package
```

`npm run package` builds the app into `release\`. Pushing a tag such as `v1.1.0` (matching
`package.json`'s version) makes GitHub build the zip and publish it on the Releases page.

CityHQ finds its server folder in this order: the `QBC_ROOT` environment variable, a server folder
it is installed inside (one holding `qbcontrol.json` or `server\FXServer.exe`), then the one chosen
on the Welcome screen (saved in `%LOCALAPPDATA%\CityHQ\cityhq.json`). A server it didn't build says
where its parts are in its `qbcontrol.json` (`fxserverDir`, `txDataDir`, `profile`, `database`).

| Folder | Contents |
| --- | --- |
| `electron\` | The desktop window and tray icon |
| `server\` | The local web server the app and phone dashboard talk to |
| `web\` | The screens (React) |
| `agent-resource\qb-control\` | A small resource the app adds to the server so it can talk to the game |
| `setup\` | The setup script and the guide it copies into each server folder |
| `site\` | The website, published to GitHub Pages by `.github/workflows/pages.yml` |

## License

CityHQ is free to use, including on servers that take donations, under the
[PolyForm Shield License 1.0.0](LICENSE.md). You may read, change and share the code, but not use
it to make a product that competes with CityHQ. It is source-available rather than "open source"
in the formal sense.

## Not affiliated

This is an independent project. It is not made or endorsed by Cfx.re, Rockstar Games, txAdmin,
the QBCore Framework or the Qbox Project.
