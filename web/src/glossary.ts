// Plain-English explanations of the words a new server owner runs into, used by <Term> and the Learn page.
export interface GlossaryEntry { term: string; short: string }

export const GLOSSARY: Record<string, GlossaryEntry> = {
  resource: { term: 'Resource (script)', short: 'One add-on for your server, in its own folder: a job, a car, a map, a phone, a menu. FiveM calls them resources; most people say scripts.' },
  ensure: { term: 'ensure', short: 'The server.cfg line that starts a resource when the server starts, like "ensure qb-core". "Start with the server" in CityHQ adds or switches off this line.' },
  servercfg: { term: 'server.cfg', short: 'The server\'s main settings file: its license key, player slots, which resources start, and who is an admin. CityHQ edits it for you and keeps a copy before every change.' },
  fxmanifest: { term: 'fxmanifest.lua', short: 'The file that makes a folder a resource. It lists the resource\'s files and what it needs to run.' },
  category: { term: 'Category folder', short: 'A folder in square brackets, like [qb] or [added], that groups resources. "ensure [qb]" in server.cfg starts everything inside it at once.' },
  txadmin: { term: 'txAdmin', short: 'FiveM\'s own control panel that runs the server process, restarts it if it stops answering, and keeps its logs. CityHQ works alongside it.' },
  fxserver: { term: 'FXServer', short: 'The FiveM server program itself. txAdmin starts it; it loads server.cfg and then your resources.' },
  framework: { term: 'Framework', short: 'The base that most roleplay scripts are built on: it handles characters, jobs, money and items. This server uses QBCore. Scripts made for another framework (ESX, vRP, Qbox) usually need a QBCore version or setting.' },
  qbcore: { term: 'QBCore', short: 'The roleplay framework this server runs on. qb-core is its main resource; resources starting with qb- come with it.' },
  esx: { term: 'ESX', short: 'A different roleplay framework. ESX-only scripts don\'t work on a QBCore server unless they have a QBCore option.' },
  dependency: { term: 'Dependency', short: 'Another resource a script needs to run, such as ox_lib or oxmysql. If one is missing, the script won\'t start.' },
  replaces: { term: 'Replaces (provides)', short: 'Some scripts say they stand in for another, like um-clothing-qb for qb-clothing. Only one of the two can run; keep the old one off.' },
  escrow: { term: 'Escrow (locked script)', short: 'Paid scripts are encrypted by FiveM so their code can\'t be read. They only run on a server whose license key belongs to the Cfx.re account that bought them.' },
  licensekey: { term: 'License key', short: 'Your server\'s key from the Cfx.re Portal (it starts with cfxk_). It identifies your server and unlocks the paid scripts that account owns. Keep it private.' },
  database: { term: 'Database', short: 'Where everything players do is saved: characters, money, items, cars, houses. Scripts that save things come with a .sql file that creates their tables.' },
  sql: { term: '.sql file', short: 'A file of database instructions that comes with many scripts. Running it once creates the tables the script saves into. CityHQ backs up the database before running one.' },
  table: { term: 'Database table', short: 'One list inside the database, like players or player_vehicles. A script fails to save if its table is missing or laid out differently than it expects.' },
  mlo: { term: 'MLO', short: 'A map add-on that adds an interior you can walk into, like a custom police station or club.' },
  stream: { term: 'Streamed files', short: 'Game files a resource sends to players: cars, clothes, maps. Players download them the first time they join, so big ones make the first join slower.' },
  oversized: { term: 'Oversized asset', short: 'A streamed game file bigger than FiveM recommends. It still works, but can cause missing textures or crashes on weaker PCs.' },
  onesync: { term: 'OneSync', short: 'FiveM\'s system for syncing players and vehicles, needed for more than 32 players and by most modern scripts. txAdmin turns it on for QBCore servers.' },
  gamebuild: { term: 'Game version (game build)', short: 'Which GTA V update the server runs, such as 3095 (The Chop Shop). It decides which cars, clothes and places exist.' },
  portforward: { term: 'Port forwarding', short: 'A router setting that sends game traffic from the internet to this PC, so friends outside your home can join. Without it, only people on your Wi-Fi can.' },
  port: { term: 'Port', short: 'A numbered door on this PC that a program listens on. FiveM servers usually use 30120 for the game (yours is shown on the Health page) and txAdmin uses 40120.' },
  ace: { term: 'ACE permissions', short: 'FiveM\'s permission system. "add_principal" lines in server.cfg make someone an admin. CityHQ\'s admin roles write these for you.' },
  identifier: { term: 'Player identifier', short: 'How the server recognises a player across visits, like license:… or discord:…. Admin roles and bans use these.' },
  hitch: { term: 'Hitch warning', short: 'The server noticed it fell behind. A few small ones are normal; huge ones (minutes) usually mean the PC slept or was very busy.' },
  heartbeat: { term: 'Heartbeat', short: 'A regular "still alive" signal the server sends to txAdmin. When it stops for too long, txAdmin restarts the server.' },
  console: { term: 'Console', short: 'The server\'s live log of everything it does, including errors. The Console page shows it and lets you type server commands.' },
  restart: { term: 'Restart', short: 'Stopping and starting the server so changes to server.cfg or scripts load. Players are saved and disconnected first.' },
  artifact: { term: 'Server artifacts', short: 'The downloadable FXServer program files. Updating them updates the server program itself.' },
};

export const GLOSSARY_LIST = Object.entries(GLOSSARY)
  .map(([id, e]) => ({ id, ...e }))
  .sort((a, b) => a.term.localeCompare(b.term));
