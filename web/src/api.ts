export type ServerState = 'online' | 'starting' | 'stopping' | 'restarting' | 'restoring' | 'stopped' | 'panel-only';

export interface ProblemLink { kind: 'doc' | 'video' | 'forum'; label: string; url: string }
export type ProblemAction =
  | { kind: 'open-file'; label: string; path: string; line?: number }
  | { kind: 'open-resource'; label: string; name: string }
  | { kind: 'install'; label: string; url: string; name: string }
  | { kind: 'run-sql'; label: string; name: string; file: string };
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
  name: string; folder: string; category: string; version: string; description: string; author: string;
  state: string;
  boot: { enabled: boolean; source: 'line' | 'category' | 'none'; turnedOffByApp: boolean };
  dependencies: string[]; missingDependencies: string[]; dependents: string[];
  installable: { name: string; url: string; from: string; resource?: string }[];
  canStop: boolean; canRemove: boolean; warnOnStop: boolean; hasEasyConfig: boolean;
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
}
export interface InventoryItem { name: string; label: string; amount: number; slot?: number }
export interface Group { name: string; label: string; grades: { level: number; name: string }[] }
export interface Shared { jobs: Group[]; gangs: Group[]; items: { name: string; label: string }[]; moneyTypes: string[] }
export interface Ban { id: number; name: string; reason: string; expire: number; bannedby: string }

export interface ConsoleLine { text: string; level: 'info' | 'warn' | 'error' }
export interface ConsoleChunk { offset: number; lines: ConsoleLine[]; reset: boolean }

export interface Settings {
  local: boolean; lanEnabled: boolean; lanListening: boolean; appPort: number; gamePort: number; txAdminPort: number;
  paths: { root: string; fxserver: string; serverData: string | null } | null;
  urls: string[]; passcode: string | null; desktop: boolean;
}

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
  start: () => request('POST', '/api/server/start', {}),
  stop: (reason?: string) => request('POST', '/api/server/stop', { reason }),
  restart: (reason?: string) => request('POST', '/api/server/restart', { reason }),
  restartLater: (minutes: number) => request<{ at: number }>('POST', '/api/server/restart-later', { minutes }),
  cancelRestartLater: () => request('DELETE', '/api/server/restart-later'),
  announce: (message: string) => request<{ players: number }>('POST', '/api/announce', { message }),
  problems: (fresh = false) => request<Problem[]>('GET', `/api/problems${fresh ? '?fresh=1' : ''}`),
  events: () => request<AppEvent[]>('GET', '/api/events'),
  markSeen: (id?: string) => request('POST', '/api/events/seen', { id }),

  backups: () => request<BackupList>('GET', '/api/backups'),
  createBackup: () => request<ServerBackup>('POST', '/api/backups'),
  restoreBackup: (id: string, parts: BackupPart[]) => request<{ safetyBackup: string; serverStarted: boolean }>('POST', `/api/backups/${q(id)}/restore`, { parts }),
  deleteBackup: (id: string) => request('DELETE', `/api/backups/${q(id)}`),
  openBackupsFolder: () => request('POST', '/api/backups/open-folder'),

  automation: () => request<Automation>('GET', '/api/automation'),
  setAutomation: (patch: Partial<Omit<Automation, 'backups'>> & { backups?: Partial<Automation['backups']> }) => request<Automation>('PUT', '/api/automation', patch),

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

  settings: () => request<Settings>('GET', '/api/settings'),
  setLan: (enabled: boolean) => request<{ lanEnabled: boolean; lanListening: boolean; errors: string[] }>('POST', '/api/settings/lan', { enabled }),
  newPasscode: () => request<{ passcode: string }>('POST', '/api/settings/passcode'),
  pairing: (url?: string) => request<{ url: string; svg: string }>('POST', '/api/settings/pairing', { url }),
};

export const SERVER_SCOPE = '__server__';
