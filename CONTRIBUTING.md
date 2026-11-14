# Working on CityHQ

Thanks for helping. CityHQ is for people running a server for the first time, so changes are judged by
whether they stay easy for them.

## Getting started

You need Windows 10 or 11 and Node.js 26. The tests use Node's own TypeScript support.

```
npm ci
npm test
npm run build
```

- `npm run desktop` opens the app from the source.
- `npm run package` builds the ready-made app into `release\`.

### A test copy that leaves your own server alone

Every push and pull request runs the same type check, tests and build on GitHub
(`.github/workflows/checks.yml`). Before that, try your change in a test copy that can't touch a server
you play on:

```
set QBC_PORT=40126
set QBC_SECONDARY=1
set QBC_HOME=C:\cityhq-test
node_modules\electron\dist\electron.exe . --user-data-dir=C:\cityhq-test\window
```

- `QBC_SECONDARY` turns off schedules, recovery and alerts.
- `QBC_HOME` gives the copy its own settings.

## Rules for changes

- **Nothing from a real server goes into the repository.** That means:
  - no `server.cfg`, `.qbcontrol` or database files
  - no license keys, passwords or API keys
  - no real player names or IDs, and no IP addresses

  Tests use made-up values. The repository is public.
- **Plain words.** Screens and messages say what happened and what to do next, without jargon. Simple
  mode stays usable by beginners, and every Pro feature has a plain, clickable path.
- **Risky actions ask first.** Kicking, banning, stopping, restarting, restoring and deleting always ask.
- **Restarts are the only automatic fix.** CityHQ may restart a server that went down. Every other fix
  needs a button the owner presses.
- **The helper never restarts itself.** CityHQ's helper (`agent-resource/qb-control`) must never stop,
  restart or ensure itself from its own code: that crashes the whole server. A new version loads at the
  next server restart.
- **Tests come with changes.** Add or update tests with each change, and keep `npm test` passing.

## Reporting bugs and ideas

- **A bug:** use **Report a problem** in CityHQ's Settings. It removes private details for you, then
  opens a report here.
- **A security problem:** see [SECURITY.md](SECURITY.md).

## License

CityHQ is under the [PolyForm Shield License 1.0.0](LICENSE.md). By contributing, you agree your
contribution is under the same license.
