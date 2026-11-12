// Who has admin powers on the server. server.cfg keeps the lasting list as add_principal lines.
// CityHQ writes its own lines inside its managed block; lines written by hand elsewhere are
// shown and can be removed, but are never rewritten.
import { editManagedBlock } from './cfg.js';

// QBCore's own roles. group.admin lines are shown as full admins (FiveM's built-in admin group).
export const ROLES = {
  god: { principal: 'qbcore.god', label: 'Owner', help: 'Every command and every admin power, including making other people admins.' },
  admin: { principal: 'qbcore.admin', label: 'Admin', help: 'Admin commands like spawning cars, giving items, teleporting, kicking and banning.' },
  mod: { principal: 'qbcore.mod', label: 'Moderator', help: 'Moderator commands like kicking players and making announcements.' },
};
// Qbox uses the groups its txAdmin recipe sets up in permissions.cfg; there is no owner level.
export const QBOX_ROLES = {
  admin: { principal: 'group.admin', label: 'Admin', help: 'Every admin command, like spawning cars, giving items, teleporting, kicking and banning. In game, Qbox asks admins to type /optin before some commands work.' },
  mod: { principal: 'group.mod', label: 'Moderator', help: 'Moderator commands like kicking players.' },
};
const ROLE_OF = {
  qbcore: { 'qbcore.god': 'god', 'qbcore.admin': 'admin', 'qbcore.mod': 'mod', 'group.admin': 'full' },
  qbox: { 'group.admin': 'admin', 'group.mod': 'mod' },
};

/** The roles CityHQ offers on this server's framework. */
export const rolesFor = (framework) => (framework === 'qbox' ? QBOX_ROLES : ROLES);
const roleOf = (framework) => ROLE_OF[framework === 'qbox' ? 'qbox' : 'qbcore'];

// Letters and digits only, so an ID can never carry anything extra into server.cfg or a command.
export const VALID_IDENTIFIER = /^(?:license2?:[a-f0-9]{8,64}|(?:fivem|discord|steam|xbl|live):[A-Za-z0-9]{1,40})$/;
const lineFor = (framework) => new RegExp(`^\\s*add_principal\\s+identifier\\.((?:license2?|fivem|discord|steam|xbl|live):[A-Za-z0-9]+)\\s+(${Object.keys(roleOf(framework)).map((p) => p.replace('.', '\\.')).join('|')})\\b\\s*(?:#\\s*(.*?))?\\s*$`, 'i');
const EOL = (text) => (text.includes('\r\n') ? '\r\n' : '\n');
const sameId = (a, b) => a.toLowerCase() === b.toLowerCase();

/** Every admin line in server.cfg, wherever it is. */
export function parseAdmins(text, framework = 'qbcore') {
  const line = lineFor(framework);
  const roles = roleOf(framework);
  const admins = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const m = line.exec(raw);
    if (!m) return;
    const principal = m[2].toLowerCase();
    admins.push({ identifier: m[1], principal, role: roles[principal], label: (m[3] || '').trim(), line: index + 1 });
  });
  return admins;
}

/** Removes every admin line for one player. Returns the new text and the roles they had. */
export function removeAdmin(text, identifier, framework = 'qbcore') {
  const line = lineFor(framework);
  const removed = [];
  const kept = text.split(/\r?\n/).filter((raw) => {
    const m = line.exec(raw);
    if (m && sameId(m[1], identifier)) {
      removed.push(m[2].toLowerCase());
      return false;
    }
    return true;
  });
  return { text: kept.join(EOL(text)), removed };
}

const safeLabel = (value) => String(value || '').replace(/[\r\n#]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);

/** Gives a player one role, replacing any role they had. Returns the new text and the old roles. */
export function setAdmin(text, identifier, role, label, framework = 'qbcore') {
  const roles = rolesFor(framework);
  if (!VALID_IDENTIFIER.test(identifier)) throw new Error('That is not a valid player ID.');
  if (!roles[role]) throw new Error(`Choose ${Object.values(roles).map((r) => r.label).join(' or ')}.`);
  const { text: cleared, removed } = removeAdmin(text, identifier, framework);
  const name = safeLabel(label);
  const line = `add_principal identifier.${identifier} ${roles[role].principal}${name ? ` # ${name}` : ''}`;
  return { text: editManagedBlock(cleared, (block) => { block.push(line); }), removed };
}
