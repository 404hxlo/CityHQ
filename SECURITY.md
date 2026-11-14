# Security

## Which versions get fixes

Only the newest version of CityHQ gets security fixes. CityHQ updates itself from **Settings**, then
**Updates**, so keep update checks on.

## Reporting a problem

Please don't open a public issue for a security problem. Use GitHub's private reporting instead: open
this repository's **Security** tab and choose **Report a vulnerability**.

Say what you found, how to make it happen, and which CityHQ version you used. Leave out your own
license keys, passwords and your players' details.

## What CityHQ protects

- **CityHQ's own web server** only answers this PC, unless you turn on phone access. Then it also answers
  your home network, behind a passcode or a one-time QR code.
- **Other websites and DNS tricks** can't drive it. It checks the address and origin of every request,
  needs its own header on every change, and keeps its sign-in cookie to its own pages.
- **Secrets are hidden.** License keys and database passwords never show on screen and are taken out of
  problem reports. A host's API key or SFTP password, and the Discord webhook, are locked with Windows'
  own protection (DPAPI), so the files are useless on another PC or Windows account.
- **Files stay inside the server.** File paths can't reach outside the server's folder, and files
  holding keys can only be viewed, not downloaded.
- **Updates are checked.** A download is checked against both checksums GitHub publishes before it's
  installed, and the old version comes back if the new one doesn't start.
- **CityHQ's helper in the game server** (qb-control) only answers this PC, and only with its secret key.
  On a hosted server it answers over HTTPS, at the address Cfx.re gives the server, with the same key.

## Known limits

- **Phone access uses plain HTTP**, so someone on the same Wi-Fi could read it. Only turn it on at home,
  on a network you trust. CityHQ warns you when Windows calls the network Public. Phones stay signed
  in for 7 days, and Settings lists them, so you can sign any of them out.
- **CityHQ isn't code-signed yet**, so Windows warns you the first time you open it.
- **Database password:** a server CityHQ builds uses its database's main account with no password. The
  database only accepts connections from this PC.
