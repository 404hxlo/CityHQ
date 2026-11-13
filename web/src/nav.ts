// Lets one page send you to a specific spot on another.
export interface FileTarget { path: string; line?: number }

let filesFolder: string | null = null;
let filesTarget: FileTarget | null = null;
let resourceTarget: string | null = null;
let addResourceUrl: string | null = null;

export function openFilesAt(folder: string, file?: FileTarget) {
  filesFolder = folder;
  filesTarget = file || null;
  if (window.location.hash === '#files') window.dispatchEvent(new Event('qbc-files-target'));
  else window.location.hash = 'files';
}

export function takeFilesTarget() {
  const value = { folder: filesFolder, file: filesTarget };
  filesFolder = null;
  filesTarget = null;
  return value;
}

export function openResourcePanel(name: string) {
  resourceTarget = name;
  if (window.location.hash === '#resources') window.dispatchEvent(new Event('qbc-resources-target'));
  else window.location.hash = 'resources';
}

export function openAddResource(url: string) {
  addResourceUrl = url;
  if (window.location.hash === '#resources') window.dispatchEvent(new Event('qbc-resources-target'));
  else window.location.hash = 'resources';
}

let playerTarget: number | null = null;

export function openPlayer(id: number) {
  playerTarget = id;
  if (window.location.hash === '#players') window.dispatchEvent(new Event('qbc-players-target'));
  else window.location.hash = 'players';
}

export function takePlayerTarget() {
  const value = playerTarget;
  playerTarget = null;
  return value;
}

/** An action chosen somewhere else (the Ctrl K box on another page), to open on Home. */
export interface HomeAction { id: string; values: Record<string, string | number | boolean | undefined>; run: boolean }
let homeAction: HomeAction | null = null;

export function openHomeAction(action: HomeAction) {
  homeAction = action;
  const hash = window.location.hash;
  if (hash === '#home' || hash === '' || hash === '#') window.dispatchEvent(new Event('qbc-home-action'));
  else window.location.hash = 'home';
}

export function takeHomeAction() {
  const value = homeAction;
  homeAction = null;
  return value;
}

export function takeResourceTargets() {
  const value = { name: resourceTarget, addUrl: addResourceUrl };
  resourceTarget = null;
  addResourceUrl = null;
  return value;
}
