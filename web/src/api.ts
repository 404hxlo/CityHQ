export type ServerState = 'online' | 'starting' | 'stopping' | 'restarting' | 'restoring' | 'stopped' | 'panel-only';

export interface ProblemLink { kind: 'doc' | 'video' | 'forum'; label: string; url: string }
export type ProblemAction =
  | { kind: 'open-file'; label: string; path: string; line?: number }
  | { kind: 'open-resource'; label: string; name: string }
  | { kind: 'install'; label: string; url: string; name: string }
  | { kind: 'run-sql'; label: string; name: string; file: string }
  /** A one-click fix: the server plans and checks it again from the problem id when pressed. */
  | { kind: 'fix'; label: string; confirm: string };
export interface FixResult { message: string; fixId: string; undoable: boolean }
/** A one-click fix offered on the Health page; the server plans it again from the item's id. */
export interface PlannedFix { label: string; confirm: string }
export interface HealthFinding {
  id: string; status: 'ok' | 'warn' | 'bad' | 'info'; title: string; detail: string; steps: string[];
  fix?: PlannedFix; goTo?: string;
}
export interface DoctorIncident {
  id: string; at: number; kind: 'paused' | 'planned' | 'crash' | 'license' | 'stuck-script' | 'hang' | 'other';
  title: string; detail: string; advice?: string; suspect?: string | null; fix?: PlannedFix;
}
export interface DoctorReport { summary: string; incidents: DoctorIncident[] }
/** Server profile: what server.cfg still controls, and where the server-list details now live. */
export interface ServerProfile { maxClients: number | null; gameBuild: number | null; gameBuildName: string | null; portalUrl: string }
/** Friends can't join? Everything between the server and players outside the home network. */
export interface ReachReport {
  port: number; localIp: string | null; gateway: string | null; profile: string | null; listening: boolean;
  firewall: { tcp: boolean; udp: boolean; ok: boolean } | null;
  listing: { status: 'ok' | 'blocked' | 'pending'; publicIp: string | null; lastFailed?: boolean };
  firewallCommand: string; local: boolean;
}
/** The install check for one script: what it needs to work here, with fixes where safe. */
export interface ScriptCheck extends HealthFinding {
  install?: { label: string; url: string };
  openFile?: { path: string; line: number; label: string };
}
export interface ScriptReport {
  name: string; checks: ScriptCheck[];
  docs: { url: string; label: string } | null;
  notes: { file: string; text: string } | null;
}
/** One change made through CityHQ, newest first, with Undo when there's a way back. */
export interface ChangeRecord {
  id: string; at: number; kind: string; title: string; detail: string; undoHint: string;
  undone: boolean; undoneAt?: number; undoable: boolean;
}
export interface FixRecord {
  id: string; at: number; problemId: string; title: string; label: string; message: string;
  undone: boolean; undoneAt?: number; undoable: boolean;
}
export interface Problem {
  id: string; rule: string; severity: 'error' | 'warning'; resource?: string | null; count: number;
  title: string; what: string; fix: string[]; actions: ProblemAction[]; links: ProblemLink[]; raw: string;
}
export interface AppEvent { id: string; at: number; level: 'alert' | 'info'; title: string; detail: string; seen: boolean }
export interface ScheduleInfo {
  pendingRestart: { at: number; reason: string } | null;
  nextRestart: number | null;
  nextBackup: number | null;
  backupRunning: { id: string; reason: string; step: string } | null;
}
export interface Automation {
  backups: { enabled: boolean; time: string; keep: number; lastAuto: number };
  restarts: { enabled: boolean; times: string[] };
  autoStartServer: boolean;
  autoRecover: boolean;
  openAtLogin: boolean | null;
  /** Ask Windows not to sleep while the server runs; the rest is what's happening right now. */
  keepAwake: {
    enabled: boolean; screenOnBattery: boolean;
    supported: boolean; holding: 'off' | 'system' | 'display'; active: boolean; serverRunning: boolean; onBattery: boolean;
  };
}
export type BackupPart = 'database' | 'settings' | 'scripts';
export interface ServerBackup { id: string; createdAt: number; reason: string; parts: BackupPart[]; size: number; tables?: number; skipped: string[] }
export interface BackupList { backups: ServerBackup[]; running: ScheduleInfo['backupRunning']; folder: string | null; canOpenFolder: boolean }
export interface InstallStatus { phase: string | null; detail?: string }
export interface RestartResult { ok: boolean; state: string; problems: Problem[] }

export interface HistoryPoint { t: number; cpu: number | null; mem: number | null; running: boolean }

export interface Overview {
  state: ServerState;
  message: string | null;
  deployed: boolean;
  folderFound: boolean;
  helperOutdated: boolean;
  serverName: string;
  gamePort: number;
  txAdminPort: number;
  processes: { txAdmin: boolean; game: boolean; database: boolean };
  /** False when the database is the owner's own (XAMPP, MySQL...), which CityHQ doesn't start. */
  databaseManaged?: boolean;
  /** The private database's port, for txAdmin's setup; null for someone's own database. */
  databasePort?: number | null;
  /** How the server folder was found; 'saved' means it was chosen on the Welcome screen. */
  rootSource?: 'folder' | 'saved' | 'env' | null;
  /** The server folder CityHQ manages (only sent to the PC itself). */
  root?: string | null;
  /** CityHQ's database tools, for someone's own database: null when the server's own are used. */
  dbTools?: { ready: boolean; progress: { step: string; mb: number | null } | null } | null;
  /** A newer CityHQ that can be installed (only sent to the PC itself). */
  update?: { version: string } | null;
  status: null | {
    uptimeSec: number; players: number; maxClients: number; gameBuild: string; version: string;
    onesync: string; qbcore: boolean; resourcesStarted: number; resourcesTotal: number;
  };
  stats: { cpuPct: number | null; memBytes: number | null; sysCpuPct: number | null; sysMemUsed: number; sysMemTotal: number };
  history: HistoryPoint[];
  problems: Problem[];
  alerts: AppEvent[];
  schedule: ScheduleInfo;
}

export interface Resource {
  /** null for resources built into FiveM, which have no folder in resources/. */
  name: string; folder: string | null; category: string; version: string; description: string; author: string;
  state: string;
  /** source 'always': started by txAdmin itself (monitor), not by server.cfg. */
  boot: { enabled: boolean; source: 'line' | 'category' | 'none' | 'always'; turnedOffByApp: boolean };
  dependencies: string[]; missingDependencies: string[]; dependents: string[];
  installable: { name: string; url: string; from: string; resource?: string }[];
  canStop: boolean; canRemove: boolean; warnOnStop: boolean; hasEasyConfig: boolean;
  /** Ships inside FXServer (chat, monitor, yarn, webpack). */
  builtIn?: boolean;
  /** A server.cfg setting the "start with the server" switch also changes, such as resources_useSystemChat. */
  setting?: { key: string; on: boolean } | null;
  /** Why it can't be stopped, when it can't. */
  lockedReason?: string | null;
  /** A running resource that stands in for this one (its `provides`), such as um-clothing-qb for qb-clothing. */
  replacedBy?: string | null;
  problem: string | null;
}
export interface ResourceList { serverOnline: boolean; resources: Resource[] }

export interface InstalledResource {
  name: string; version: string; description: string; dependencies: string[];
  missingDependencies: string[]; sqlFiles: string[];
}

export interface FileEntry { path: string; editable: boolean; size: number }
export interface Field {
  id: string; line: number; key: string; label: string; group: string; help: string;
  type: 'boolean' | 'number' | 'string'; value: boolean | number | string;
}
export interface EditableFile {
  path: string; content: string; etag: string; fieldKind: string | null; fields: Field[];
  readOnly: boolean; readOnlyReason: string | null;
  backupId?: string | null; syntaxChecked?: boolean;
}
export interface BrowseEntry {
  name: string; path: string; type: 'dir' | 'file'; size: number; modified: number;
  items?: number; kind?: 'text' | 'image' | 'other';
}
export interface BrowseFolder { path: string; entries: BrowseEntry[]; truncated: boolean }
export interface FileDetails {
  path: string; name: string; size: number; modified: number;
  kind: 'text' | 'image' | 'binary' | 'large';
  editor: { scope: string; path: string };
  resourceRunning: boolean; canDownload: boolean;
}
export interface SearchHit { path: string; name: string; type: 'dir' | 'file'; line?: number; text?: string }
export interface SearchResponse { results: SearchHit[]; truncated: boolean; timedOut: boolean }
export interface FileVersion { id: string; savedAt: number; size: number }
export interface TrashItem { id: string; name: string; origin: string; removedAt: number }

export interface Player {
  id: number; name: string; ping: number; license?: string; citizenid?: string; character?: string;
  money?: Record<string, number>;
  job?: { name: string; label: string; grade: number; gradeName?: string; onduty?: boolean };
  gang?: { name: string; label: string; grade: number; gradeName?: string };
  frozen?: boolean; jailMonths?: number;
}
export interface InventoryItem { name: string; label: string; amount: number; slot?: number }
export interface Group { name: string; label: string; grades: { level: number; name: string }[] }
export interface VehicleModel { model: string; name: string; brand?: string; category?: string }
export interface Shared {
  jobs: Group[]; gangs: Group[]; items: { name: string; label: string }[]; moneyTypes: string[];
  vehicles?: VehicleModel[]; places?: { key: string; label: string }[];
}

export interface SeriesPoint { t: number; v: number | null }
export interface DayCount { unique: number; peak: number }
export interface ActivityItem { t: number; kind: 'join' | 'leave'; name: string; character: string | null }
export interface UpcomingItem { kind: 'countdown' | 'restart' | 'backup'; at: number; title: string; detail: string }
export interface Dashboard {
  day: SeriesPoint[]; week: SeriesPoint[];
  today: DayCount; yesterday: DayCount; days: ({ day: string } & DayCount)[];
  activity: ActivityItem[]; upcoming: UpcomingItem[];
  history: Record<string, { backup?: number; crash?: number; restart?: number }>;
  schedule: { restarts: string[]; backup: string | null };
  greetingName: string;
}
export interface World { weather: string; blackout: boolean; timeFrozen: boolean; dynamicWeather: boolean; hour: number; minute: number }
export interface KnownPlayer { license: string; name: string; characters: { citizenid: string; name: string }[]; lastSeen: number; ids: string[] }
export interface Whitelist { enabled: boolean; entries: { id: string; name: string }[]; live: { enabled: boolean } | null; applied?: boolean }
export type AdminRole = 'god' | 'admin' | 'mod';
export interface AdminEntry { identifier: string; principal: string; role: AdminRole | 'full'; label: string; line: number; name: string | null }
export interface AdminsResponse {
  admins: AdminEntry[];
  roles: Record<AdminRole, { principal: string; label: string; help: string }>;
  players: KnownPlayer[];
  playersError: string | null;
}
export interface Ban { id: number; name: string; reason: string; expire: number; bannedby: string }

export interface ConsoleLine { text: string; level: 'info' | 'warn' | 'error' }
export interface ConsoleChunk { offset: number; lines: ConsoleLine[]; reset: boolean }

export interface Settings {
  local: boolean; lanEnabled: boolean; lanListening: boolean; appPort: number; gamePort: number; txAdminPort: number;
  paths: { root: string; fxserver: string; serverData: string | null } | null;
  urls: string[]; passcode: string | null; desktop: boolean;
  rootSource?: 'folder' | 'saved' | 'env' | null; databaseManaged?: boolean;
}

/** One server found on this PC, or the folder someone picked, as the Welcome screen reads it. */
export interface ServerCandidate {
  folder: string; found: boolean; root: string; fxserverDir: string | null; txDataDir: string | null; profile: string;
  dataPath: string | null; cfgPath: string | null; gamePort: number; txAdminPort: number; qbcore: boolean; cityhqMade: boolean;
  database: { host: string; port: number; user: string; name: string; hasPassword: boolean; managed: boolean } | null;
  problems: { level: 'bad' | 'warn' | 'info'; text: string }[];
  txAdminRunning?: boolean; databaseUp?: boolean;
}
export interface WelcomeInfo { folderFound: boolean; rootSource: string | null; root: string | null; desktop: boolean; suggestedNewFolder: string }
export interface NewServerJob { running: boolean; root: string; lines: string[]; ok: boolean | null; error: string | null; startedAt: number }
export interface DbToolsState { ready: boolean; running: boolean; progress: { step: string; mb: number | null } | null; error: string | null }
export interface WelcomeProgress { tools: DbToolsState; newServer: NewServerJob | null }

/** An error from the app that may carry details, like where a mistake in a file is. */
export class ApiError extends Error {
  status: number;
  data: { syntax?: { line?: number; message?: string; plain: string } } | null;
  constructor(message: string, status: number, data: ApiError['data']) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

const listeners = new Set<() => void>();
export const onSignedOut = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'x-qbc-client': '1' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new Error('Cannot reach CityHQ. Check that the app is open on your PC.');
  }
  let data: ({ error?: string } & ApiError['data']) | null = null;
  try { data = await res.json(); } catch { /* no JSON body */ }
  if (res.status === 401 && !url.endsWith('/login') && !url.endsWith('/pair')) listeners.forEach((fn) => fn());
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status})`, res.status, data);
  return data as T;
}

/** Uploads with progress, which fetch can't report and a big file really needs. */
function uploadWithProgress(url: string, file: File, onProgress: (fraction: number) => void) {
  return new Promise<{ installed: InstalledResource[] }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('x-qbc-client', '1');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onerror = () => reject(new Error('The upload could not finish. Check your connection and try again.'));
    xhr.onload = () => {
      let data: { error?: string; installed?: InstalledResource[] } | null = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* handled below */ }
      if (xhr.status >= 200 && xhr.status < 300 && data?.installed) resolve({ installed: data.installed });
      else reject(new Error(data?.error || `Upload failed (${xhr.status})`));
    };
    xhr.send(file);
  });
}

const q = encodeURIComponent;

export const api = {
  session: () => request<{ authed: boolean; local: boolean }>('GET', '/api/session'),
  login: (passcode: string) => request('POST', '/api/login', { passcode }),
  pair: (token: string) => request('POST', '/api/pair', { token }),
  logout: () => request('POST', '/api/logout'),

  overview: () => request<Overview>('GET', '/api/overview'),
  welcome: () => request<WelcomeInfo>('GET', '/api/welcome'),
  welcomeScan: () => request<ServerCandidate[]>('GET', '/api/welcome/scan'),
  welcomeCheck: (folder: string) => request<ServerCandidate>('POST', '/api/welcome/check', { folder }),
  welcomePick: () => request<{ folder?: string; cancelled?: boolean }>('POST', '/api/welcome/pick'),
  welcomeUse: (folder: string, txAdminPort?: number) => request<{ root: string; external: boolean; needsTools: boolean }>('POST', '/api/welcome/use', { folder, txAdminPort }),
  welcomeTools: () => request<DbToolsState>('POST', '/api/welcome/tools'),
  welcomeProgress: () => request<WelcomeProgress>('GET', '/api/welcome/progress'),
  welcomeNew: (folder: string) => request<NewServerJob>('POST', '/api/welcome/new', { folder }),
  welcomeRelaunch: () => request<{ relaunching: boolean }>('POST', '/api/welcome/relaunch'),
  welcomeForget: () => request<{ relaunching: boolean }>('POST', '/api/welcome/forget'),
  startPanel: () => request<{ started?: boolean; alreadyRunning?: boolean }>('POST', '/api/server/start-panel'),
  txAdminPin: () => request<{ pin: string | null; panelUp: boolean }>('GET', '/api/server/pin'),
  start: () => request('POST', '/api/server/start', {}),
  stop: (reason?: string) => request('POST', '/api/server/stop', { reason }),
  restart: (reason?: string) => request('POST', '/api/server/restart', { reason }),
  restartLater: (minutes: number) => request<{ at: number }>('POST', '/api/server/restart-later', { minutes }),
  cancelRestartLater: () => request('DELETE', '/api/server/restart-later'),
  announce: (message: string) => request<{ players: number }>('POST', '/api/announce', { message }),
  problems: (fresh = false) => request<Problem[]>('GET', `/api/problems${fresh ? '?fresh=1' : ''}`),
  fixProblem: (id: string) => request<FixResult>('POST', '/api/problems/fix', { id }),
  profile: () => request<ServerProfile>('GET', '/api/profile'),
  setSlots: (maxClients: number) => request<ServerProfile>('PUT', '/api/profile/slots', { maxClients }),
  reach: () => request<ReachReport>('GET', '/api/reach'),
  reachFirewall: () => request<{ asked: boolean }>('POST', '/api/reach/firewall'),
  scriptCheck: (name: string) => request<ScriptReport>('GET', `/api/resources/${q(name)}/check`),
  scriptCheckFix: (name: string, id: string) => request<FixResult>('POST', `/api/resources/${q(name)}/check/fix`, { id }),
  history: () => request<ChangeRecord[]>('GET', '/api/history'),
  undoChange: (id: string) => request<{ message: string }>('POST', `/api/history/${q(id)}/undo`),
  health: () => request<HealthFinding[]>('GET', '/api/health'),
  healthFix: (id: string) => request<FixResult>('POST', '/api/health/fix', { id }),
  doctor: () => request<DoctorReport>('GET', '/api/health/doctor'),
  doctorFix: (id: string) => request<FixResult>('POST', '/api/health/doctor/fix', { id }),
  recentFixes: () => request<FixRecord[]>('GET', '/api/problems/fixes'),
  undoFix: (id: string) => request<{ message: string }>('POST', `/api/problems/fixes/${q(id)}/undo`),
  events: () => request<AppEvent[]>('GET', '/api/events'),
  markSeen: (id?: string) => request('POST', '/api/events/seen', { id }),

  backups: () => request<BackupList>('GET', '/api/backups'),
  createBackup: () => request<ServerBackup>('POST', '/api/backups'),
  restoreBackup: (id: string, parts: BackupPart[]) => request<{ safetyBackup: string; serverStarted: boolean }>('POST', `/api/backups/${q(id)}/restore`, { parts }),
  deleteBackup: (id: string) => request('DELETE', `/api/backups/${q(id)}`),
  openBackupsFolder: () => request('POST', '/api/backups/open-folder'),

  automation: () => request<Automation>('GET', '/api/automation'),
  setAutomation: (patch: Partial<Omit<Automation, 'backups' | 'keepAwake'>> & {
    backups?: Partial<Automation['backups']>;
    keepAwake?: { enabled?: boolean; screenOnBattery?: boolean };
  }) => request<Automation>('PUT', '/api/automation', patch),

  console: (since?: number) => request<ConsoleChunk>('GET', `/api/console${since === undefined ? '' : `?since=${since}`}`),
  command: (command: string) => request('POST', '/api/console/command', { command }),

  resources: () => request<ResourceList>('GET', '/api/resources'),
  refresh: () => request<ResourceList>('POST', '/api/resources/refresh'),
  resourceAction: (name: string, action: string) => request<{ state: string }>('POST', `/api/resources/${q(name)}/action`, { action }),
  restartChecked: (name: string) => request<RestartResult>('POST', `/api/resources/${q(name)}/restart-checked`),
  sqlFiles: (name: string) => request<string[]>('GET', `/api/resources/${q(name)}/sql-files`),
  installStatus: () => request<InstallStatus>('GET', '/api/resources/install/status'),
  installPick: (type: 'file' | 'folder') => request<{ installed?: InstalledResource[]; cancelled?: boolean }>('POST', '/api/resources/install/pick', { type }),
  setBoot: (name: string, enabled: boolean) => request<{ stoppedNow?: boolean }>('POST', `/api/resources/${q(name)}/boot`, { enabled }),
  activate: (name: string, boot: boolean, start: boolean) => request('POST', `/api/resources/${q(name)}/activate`, { boot, start }),
  runSql: (name: string, file: string) => request('POST', `/api/resources/${q(name)}/sql`, { file }),
  removeResource: (name: string) => request('DELETE', `/api/resources/${q(name)}`),
  installGithub: (url: string) => request<{ installed: InstalledResource[] }>('POST', '/api/resources/install/github', { url }),
  installUpload: (file: File, onProgress: (fraction: number) => void) => uploadWithProgress(`/api/resources/install/upload?filename=${q(file.name)}`, file, onProgress),
  trash: () => request<TrashItem[]>('GET', '/api/trash'),
  restoreTrash: (id: string) => request('POST', `/api/trash/${q(id)}/restore`),

  files: (scope: string) => request<{ files: FileEntry[]; truncated: boolean }>('GET', `/api/files?scope=${q(scope)}`),
  file: (scope: string, path: string) => request<EditableFile>('GET', `/api/file?scope=${q(scope)}&path=${q(path)}`),
  saveFile: (scope: string, path: string, content: string, etag: string, force = false) => request<EditableFile>('PUT', '/api/file', { scope, path, content, etag, force }),
  saveFields: (scope: string, path: string, changes: { id: string; value: unknown }[], etag: string, force = false) => request<EditableFile>('PUT', '/api/file/fields', { scope, path, changes, etag, force }),
  versions: (scope: string, path: string) => request<FileVersion[]>('GET', `/api/file/versions?scope=${q(scope)}&path=${q(path)}`),
  restoreVersion: (scope: string, path: string, id: string) => request<EditableFile>('POST', '/api/file/restore', { scope, path, id }),

  browse: (path: string) => request<BrowseFolder>('GET', `/api/browse?path=${q(path)}`),
  fileDetails: (path: string) => request<FileDetails>('GET', `/api/browse/info?path=${q(path)}`),
  searchFiles: (query: string, mode: 'names' | 'text', path: string) => request<SearchResponse>('GET', `/api/browse/search?q=${q(query)}&mode=${mode}&path=${q(path)}`),
  rawUrl: (path: string, download = false) => `/api/browse/raw?path=${q(path)}${download ? '&download=1' : ''}`,

  players: () => request<Player[]>('GET', '/api/players'),
  shared: () => request<Shared>('GET', '/api/shared'),
  inventory: (id: number) => request<InventoryItem[]>('GET', `/api/players/${id}/inventory`),
  playerAction: (id: number, action: string, extra: Record<string, unknown> = {}) => request<{ message: string }>('POST', `/api/players/${id}/action`, { action, ...extra }),
  bans: () => request<Ban[]>('GET', '/api/bans'),
  unban: (id: number) => request('DELETE', `/api/bans/${id}`),

  dashboard: () => request<Dashboard>('GET', '/api/dashboard'),
  setGreeting: (name: string) => request<{ greetingName: string }>('PUT', '/api/settings/greeting', { name }),
  world: () => request<World>('GET', '/api/city/world'),
  setWorld: (patch: Partial<World>) => request<World>('POST', '/api/city/world', patch),
  banner: (title: string, message: string, seconds: number, countdown: boolean) => request<{ players: number }>('POST', '/api/city/banner', { title, message, seconds, countdown }),
  reviveAll: () => request<{ revived: number }>('POST', '/api/city/revive-all'),
  clearVehicles: (seconds: number) => request<{ removed?: number; scheduled?: number }>('POST', '/api/city/clear-vehicles', { seconds }),
  whitelist: () => request<Whitelist>('GET', '/api/city/whitelist'),
  setWhitelist: (change: { enabled?: boolean; add?: { id: string; name: string }; remove?: string }) => request<Whitelist>('PUT', '/api/city/whitelist', change),
  knownPlayers: () => request<KnownPlayer[]>('GET', '/api/known-players'),
  admins: () => request<AdminsResponse>('GET', '/api/admins'),
  addAdmin: (identifier: string, role: AdminRole, name: string) => request<{ saved: boolean; live: boolean }>('POST', '/api/admins', { identifier, role, name }),
  removeAdmin: (identifier: string) => request<{ removed: number; live: boolean }>('DELETE', `/api/admins/${q(identifier)}`),

  settings: () => request<Settings>('GET', '/api/settings'),
  setLan: (enabled: boolean) => request<{ lanEnabled: boolean; lanListening: boolean; errors: string[] }>('POST', '/api/settings/lan', { enabled }),
  newPasscode: () => request<{ passcode: string }>('POST', '/api/settings/passcode'),
  pairing: (url?: string) => request<{ url: string; svg: string }>('POST', '/api/settings/pairing', { url }),

  updates: () => request<UpdateStatus>('GET', '/api/updates'),
  checkUpdates: () => request<UpdateStatus>('POST', '/api/updates/check'),
  installUpdate: () => request<UpdateStatus>('POST', '/api/updates/install'),
  setAutoUpdate: (enabled: boolean) => request<UpdateStatus>('PUT', '/api/updates/auto', { enabled }),
};

export interface UpdateStatus {
  current: string;
  available: boolean;
  latest: { version: string; notes: string; page: string; publishedAt: string | null; sizeMb: number | null } | null;
  checking: boolean;
  checkedAt: number | null;
  error: string | null;
  autoCheck: boolean;
  /** Why this copy can't install it by itself (then it's downloaded from GitHub instead). */
  cantInstall: string | null;
  job: { step: string; mb: number; totalMb: number | null; error: string | null; done: boolean } | null;
  lastLog: string | null;
}

export const SERVER_SCOPE = '__server__';
