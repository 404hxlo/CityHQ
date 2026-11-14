# Privacy

CityHQ has no accounts, ads, analytics or tracking. It keeps what it needs on your PC (and in your
server), and only contacts the services below. This page lists both.

## What CityHQ keeps, and where

### In your server's folder, in `.qbcontrol`

- `settings.json`, plus a spare copy, `settings.json.bak`, kept each time CityHQ starts:
  - the phone passcode
  - signed-in devices: each sign-in stored only as a scrambled hash, with a short device name (such as
    "Android phone · Chrome") and when it was last used. Phones stay signed in for 7 days, CityHQ's
    own window for 30.
  - the helper's secret key
  - your schedules, the whitelist and the name Home greets you by
- `server-backups`: full backups, which hold everything below. **Keep them private.**
  - your whole database, with all player data
  - `server.cfg`, including your license key and database password
  - your scripts
- `backups`: earlier copies of files you edited in CityHQ, `server.cfg` included.
- `people.json`: the IDs of players who joined (license, Discord, Steam, Xbox, FiveM) and their names,
  so admins and the whitelist can be picked by name. CityHQ never keeps players' IP addresses.
- `stats.json` and `activity.json`: how many played and when, and the last 300 joins and leaves, with
  player and character names.
- `crashes.json`: the last 30 crashes, each with a few lines of the server log from just before it.
- `events.json`, `history.json`, `fixes.json`: what CityHQ did and what changed, so it can be undone.
- `trash`: scripts you removed, until you delete them.
- `discord-webhook.bin`: the Discord link for crash alerts, if you set one, locked with Windows' own
  protection.

### Elsewhere on this PC

- `logs\control-app.log` in the server's folder: CityHQ's own errors.
- `%LOCALAPPDATA%\CityHQ`:
  - which server CityHQ manages
  - the database programs it downloaded
  - update downloads and their log
  - for a hosted server, CityHQ's state for it. Its panel key or SFTP password is in a file locked with
    Windows' own protection.
- `%APPDATA%\CityHQ`: the window's own browser data, which holds:
  - the sign-in cookie
  - your Simple or Pro choice
  - commands you typed on Home

### On the game server

- CityHQ's helper, in `resources\[local]\qb-control`, with its secret key in `token.txt`.
- A marked section in `server.cfg`, which CityHQ manages.
- The whitelist, kept inside the server, so it still works when CityHQ is closed.

## What leaves this PC

| When | Where to | What is sent |
| --- | --- | --- |
| Checking for updates (shortly after start, then every 6 hours; you can turn this off in Settings) | `api.github.com` | A request for the newest version |
| Installing an update you chose | `github.com` | The download request |
| First use with your own database (XAMPP, MySQL...) | `archive.mariadb.org` | A download of MariaDB's official database programs |
| Installing a script from a GitHub link | `github.com`, `codeload.github.com` | The link you pasted |
| Linking to scripts' documentation (once a month per page) | `qbcore.org`, `docs.qbox.re`, `overextended.dev` | A check that a page exists, which shows those sites the names of the qb-, qbx_ and ox_ scripts you have |
| A crash, if you set up Discord | `discord.com` | CityHQ's summary: the server's name, what happened, the likely cause (a script's name, or FiveM's own words, such as why it refused the license key, never the key itself) and what to do. No player names, and nothing from server.cfg. |
| A hosted server | Your host's panel and SFTP server | What managing it needs: files, power, console and backups |
| A hosted server (every 5 minutes) | `servers-frontend.fivem.net` | The server's join code, to ask whether FiveM's list shows it |
| A hosted server | The server's Cfx.re address (`*.users.cfx.re`) | Requests to CityHQ's helper, over HTTPS, with its secret key |
| Phone access, if you turn it on | Only your home network | The dashboard, to your phone |
| Building a new server | `runtime.fivem.net`, `changelogs-live.fivem.net`, `archive.mariadb.org` | Downloads of FiveM's server and MariaDB |

**Report a problem** sends nothing itself. It removes private details first and shows you the whole
report. Then you choose whether to open it on GitHub, where reports are public.

## Removing CityHQ and what it kept

1. In CityHQ's Settings, turn off **Open CityHQ when Windows starts**. Then quit CityHQ from its tray icon.
2. Delete the CityHQ folder, then `%LOCALAPPDATA%\CityHQ` and `%APPDATA%\CityHQ`.
3. In your server's folder, delete `.qbcontrol` and `logs\control-app.log`. Copy any backups you want to
   keep first.
4. Delete `resources\[local]\qb-control`.
5. Remove CityHQ's section from `server.cfg`: the lines from `# >>> CityHQ` to `# <<< CityHQ`. Keep any
   lines in it you still want, such as `ensure` lines for scripts you installed.
6. If you let CityHQ add firewall rules, delete "FiveM server (CityHQ) TCP" and "FiveM server (CityHQ)
   UDP" in Windows Defender Firewall's inbound rules.
