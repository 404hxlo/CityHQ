# What's new in CityHQ

Each version's section is shown in the app before it updates, and on its GitHub release page.

## 1.5.0

- Move to a host: under Settings, CityHQ moves the server on this PC to one you rent (RocketNode and other hosts). It takes every resource, maps and cars included, plus the database and server.cfg.
- Before anything changes, it checks the space on your host, the database, and whether your resources are already uploaded.
- The upload picks up where it stopped if the internet drops or CityHQ closes, and the PC is kept awake while it runs.
- With a panel API key, your host unpacks the resources itself, which is much faster. With SFTP only, files go up one by one.
- You finish the move yourself, when nobody is on. CityHQ stops the server here, copies the database and settings, starts it on your host and switches over.
- Your server on this PC is never deleted. The host's old resources and server.cfg are kept as copies too.

## 1.4.1

- Hosted servers: the join address is your server's Cfx.re join link (or your host's address), not "localhost".
- Hosted servers connected over SFTP show their own name instead of the SFTP address.
- Hosted servers no longer show a nightly backup under Coming up, since CityHQ doesn't back them up yet.
- When a hosted server's helper isn't answering yet, CityHQ says to restart the server from your host's panel.

## 1.4.0

- CityHQ can now run a server you rent from a host, such as RocketNode. On the Welcome screen (or Settings, Change server) choose "It's hosted", then connect with your panel's API key or with SFTP.
- With a panel API key (RocketNode and other Pterodactyl-style panels): start, stop and restart, the live console, CPU and memory, and editing files.
- With SFTP, which works with almost any host: editing files and the console from txAdmin's log. Start and stop the server from your host's panel.
- Players, City, Admins, the whitelist and turning resources on and off work through CityHQ's helper, which is added when you connect and starts at the server's next restart.
- Your API key or password stays on your PC, locked with Windows' own protection, and is taken out of problem reports.
- Not for hosted servers yet: Health, Backups, finding problems and installing scripts.

## 1.3.0

- CityHQ now works with Qbox servers as well as QBCore. It recognises a Qbox server when you connect it, and "Make me a new server" lets you choose QBCore or Qbox.
- On Qbox, the player tools use Qbox's own scripts: money, jobs, gangs, ox_inventory items, revive (qbx_medical), jail (xt-prison), weather (Renewed-Weathersync), cars with keys, and Qbox's admin groups.
- The install check and problem tips know Qbox: Qbox scripts count as a fit, QBCore scripts run through Qbox's QBCore bridge, and links go to Qbox's documentation.
- Servers that use ox_inventory with QBCore can now give and remove items from CityHQ.
- Buttons for things a server can't do, such as jail without a jail script, are hidden instead of failing.
- CityHQ's helper inside the server updates at its next restart.

## 1.2.1

- Report a problem, under Settings and on the Welcome screen: describe what went wrong, check the report, then open it on GitHub or copy it. CityHQ's version, the kind of setup and the last lines of its log can go with it, with license keys, passwords, player IDs, IP addresses and your Windows user name taken out. Nothing is sent until you choose to.

## 1.2.0

- CityHQ now updates itself. It checks for a new version every few hours, shows what changed, and installs it when you press Update now. Your game server keeps running while it does.
- Every download is checked against its published checksum before it's installed. If the new version doesn't open, the old one is put back.
- You can turn off automatic checks under Settings, Updates.

## 1.1.3

- "What changed" no longer shows "Invalid Date" for a fix that was undone.

## 1.1.2

- A new copy always opens on the Welcome screen.
- The GitHub page has a one-click download link.

## 1.1.1

- The Welcome screen reads a server's main folder correctly.

## 1.1.0

- CityHQ works with other people's servers: a Welcome screen finds an existing server (txAdmin, ports and a database such as XAMPP) or builds a new one.
- Ready-made download on GitHub Releases.
