# What's new in CityHQ

Each version's section is shown in the app before it updates, and on its GitHub release page.

## 1.8.1

- On Home, **See all** under Things to fix opens the whole list, with its fixes, right there. Before, it sent you to the Health page, which has its own checks rather than this list, and on a phone it miscounted how many more there were.
- The red count of things to fix now sits on Home in the menu, where they're listed, instead of on Health.

## 1.8.0

- **A new look.** CityHQ is now a proper desktop app: its own title bar with your server's name and Windows' own window buttons, a menu down the side, a status bar along the bottom, and calm dark panels instead of glowing cards.
- **A new Home page.** Type what you want to do in your own words, like "kick a player", "make it rain" or "give Lena a bandage". Suggestions show as you type. Things that need details open a short form, and risky ones (kick, ban, stop, restart) always ask first.
- Everything you do on Home shows up there as a block, with the result. The live log is right underneath, and a panel beside it shows who's on, how hard the server is working, anything to fix and what's coming up.
- **Simple and Pro.** Simple, the default, adds a welcome, clickable starting points, and plain-word summaries of the log. Pro shows the command for everything, the raw log, the console, and runs anything else you type as a server command, like txAdmin. Switch at the top right.
- **Ctrl K** brings up the same box on any page to find a player, a script or a page, or to start an action.
- The old dashboard is now **Stats**: players, CPU and memory over time, and the calendar.
- The banner preview on the City page now looks like the in-game announcement.
- Settings' "New to running a server?" card no longer leaves a big empty space.

## 1.7.2

- Move to a host can sign in to hosted database servers that only take encrypted connections. CityHQ tries an ordinary connection first and an encrypted one after, and your server on the host is set up the same way.
- When CityHQ can't sign in to your host's database, it shows the database's own error message, so you can tell a wrong password from a blocked connection.
- If your host's panel doesn't give CityHQ a database's password, or the one it gives doesn't work, CityHQ asks you to type it (the eye button in your panel's Databases tab shows it).

## 1.7.1

- Move to a host works with panels that don't share their database's address, such as RocketNode's. CityHQ looks for it in more places, and if the panel doesn't give it, asks you to type the Endpoint from your panel's Databases tab.
- The new database for your server is made when the move starts, and CityHQ checks it can sign in to it then. Before, that was only found out at the very end, after your server on this PC had stopped.
- If a move was started before, CityHQ uses the database it already made instead of making another.

## 1.7.0

- New look for CityHQ's messages in game. Announcements appear at the top of the screen with a purple tag, a large title and a timer line that shrinks until they close. They replace GTA's old big-message banner.
- Small messages, such as "Your car was repaired" or a message from staff, appear on the right in the same style, with a tag that says who they're from. They stack when several arrive at once.
- Restart warnings, Clear the streets and messages to one player use the new look too.
- CityHQ's helper on the server updates to 1.7.0 at its next restart.

## 1.6.0

- Hosted servers get **Health**: CityHQ's helper, the database, the start order, scripts server.cfg starts that aren't there, and your plan's disk and memory. The PC-only checks (sleep, firewall, router) aren't shown.
- Hosted servers get **Problems**: the same plain-English explanations as a server on your PC, from your host's live console, with one-click fixes for server.cfg.
- Hosted servers get **Backups**:
  - With a panel API key, your host's own backups. Make them, download them, and restore them after a confirm.
  - With any host, CityHQ's copy of the database and server.cfg, kept on your PC.
- Hosted servers can **install scripts** from a zip, a folder or GitHub. CityHQ unpacks and reads them on your PC, then sends them to your host. **Remove** moves them aside on your host, and Undo puts them back.
- The Resources page shows what each script needs on hosted servers too.
- CityHQ's helper on the server updates to 1.6.0 at its next restart.

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
