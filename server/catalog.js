// Official sources for resources that others commonly depend on, so a missing one can be
// installed with a button. Every URL here was checked to exist; nothing else is guessed at.
const OX = (name) => `https://github.com/overextended/${name}/releases/latest/download/${name}.zip`;
const QB = (name) => `https://github.com/qbcore-fivem/${name}`;

const KNOWN = {
  ox_lib: { url: OX('ox_lib'), from: 'overextended' },
  // ox_lib's official release also contains the loader that provides `require`.
  require: { url: OX('ox_lib'), from: 'overextended', resource: 'ox_lib' },
  'cfxlua-require': { url: OX('ox_lib'), from: 'overextended', resource: 'ox_lib' },
  oxmysql: { url: OX('oxmysql'), from: 'overextended' },
  ox_target: { url: OX('ox_target'), from: 'overextended' },
  ox_inventory: { url: OX('ox_inventory'), from: 'overextended' },
  polyzone: { url: 'https://github.com/mkafrin/PolyZone', from: 'mkafrin', resource: 'PolyZone' },
  'pma-voice': { url: 'https://github.com/AvarianKnight/pma-voice', from: 'AvarianKnight' },
  menuv: { url: 'https://github.com/ThymonA/menuv/releases/download/v1.4.1/menuv_v1.4.1.zip', from: 'ThymonA' },
  'screenshot-basic': { url: 'https://github.com/citizenfx/screenshot-basic', from: 'citizenfx' },
  'qb-target': { url: QB('qb-target'), from: 'QBCore' },
  'qb-menu': { url: QB('qb-menu'), from: 'QBCore' },
  'qb-input': { url: QB('qb-input'), from: 'QBCore' },
  progressbar: { url: QB('progressbar'), from: 'QBCore' },
  'interact-sound': { url: QB('interact-sound'), from: 'QBCore' },
};

/** Where to get a resource, or null. Names outside this list are left for the person to find. */
export function findInstallSource(name) {
  const entry = KNOWN[String(name || '').toLowerCase()];
  return entry ? { name, ...entry } : null;
}
