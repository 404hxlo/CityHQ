// Who has admin powers on the server. server.cfg keeps the lasting list as add_principal lines.
// CityHQ writes its own lines inside its managed block; lines written by hand elsewhere are
// shown and can be removed, but are never rewritten.
import { editManagedBlock } from './cfg.js';

export const ROLES = {
  god: { principal: 'qbcore.god', label: 'Owner', help: 'Every command and every admin power, including making other people admins.' },
  admin: { principal: 'qbcore.admin', label: 'Admin', help: 'Admin commands like spawning cars, giving items, teleporting, kicking and banning.' },
  mod: { principal: 'qbcore.mod', label: 'Moderator', help: 'Moderator commands like kicking players and making announcements.' },
};
const ROLE_OF = { 'qbcore.god': 'god', 'qbcore.admin': 'admin', 'qbcore.mod': 'mod', 'group.admin': 'full' };

// Letters and digits only, so an ID can never carry anything extra into server.cfg or a command.
export const VALID_IDENTIFIER = /^(?:license2?:[a-f0-9]{8,64}|(?:fivem|discord|steam|xbl|live):[A-Za-z0-9]{1,40})$/;
const LINE = /^\s*add_principal\s+identifier\.((?:license2?|fivem|discord|steam|xbl|live):[A-Za-z0-9]+)\s+(qbcore\.god|qbcore\.admin|qbcore\.mod|group\.admin)\b\s*(?:#\s*(.*?))?\s*$/i;
const EOL = (text) => (text.includes('\r\n') ? '\r\n' : '\n');
const sameId = (a, b) => a.toLowerCase() === b.toLowerCase();

/** Every admin line in server.cfg, wherever it is. */
export function parseAdmins(text) {
  const admins = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const m = LINE.exec(line);
    if (!m) return;
    const principal = m[2].toLowerCase();
    admins.push({ identifier: m[1], principal, role: ROLE_OF[principal], label: (m[3] || '').trim(), line: index + 1 });
  });
  return admins;
}

/** Removes every admin line for one player. Returns the new text and the roles they had. */
export function removeAdmin(text, identifier) {
  const removed = [];
  const kept = text.split(/\r?\n/).filter((line) => {
    const m = LINE.exec(line);
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
export function setAdmin(text, identifier, role, label) {
  if (!VALID_IDENTIFIER.test(identifier)) throw new Error('That is not a valid player ID.');
  if (!ROLES[role]) throw new Error('Choose Owner, Admin or Moderator.');
  const { text: cleared, removed } = removeAdmin(text, identifier);
  const name = safeLabel(label);
  const line = `add_principal identifier.${identifier} ${ROLES[role].principal}${name ? ` # ${name}` : ''}`;
  return { text: editManagedBlock(cleared, (block) => { block.push(line); }), removed };
}
