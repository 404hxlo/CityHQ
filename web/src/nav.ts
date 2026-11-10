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

export function takeResourceTargets() {
  const value = { name: resourceTarget, addUrl: addResourceUrl };
  resourceTarget = null;
  addResourceUrl = null;
  return value;
}
