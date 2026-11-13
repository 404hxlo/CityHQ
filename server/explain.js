// Turns raw server log lines into: what happened, how to fix it, and where to read more.
// Search links are built only from fixed wording and resource names, never from the log itself,
// so paths, queries and player details can't end up in a URL.
import { findInstallSource } from './catalog.js';

const enc = encodeURIComponent;

export const DOCS = {
  resources: { kind: 'doc', label: 'FiveM docs: how resources work', url: 'https://docs.fivem.net/docs/scripting-manual/introduction/introduction-to-resources/' },
  manifest: { kind: 'doc', label: 'FiveM docs: the fxmanifest file', url: 'https://docs.fivem.net/docs/scripting-reference/resource-manifest/resource-manifest/' },
  lua: { kind: 'doc', label: 'FiveM docs: Lua scripting', url: 'https://docs.fivem.net/docs/scripting-reference/runtimes/lua/' },
  commands: { kind: 'doc', label: 'FiveM docs: server.cfg commands', url: 'https://docs.fivem.net/docs/server-manual/server-commands/' },
  setup: { kind: 'doc', label: 'FiveM docs: setting up txAdmin', url: 'https://docs.fivem.net/docs/server-manual/setting-up-a-server-txadmin/' },
  qbcore: { kind: 'doc', label: 'QBCore documentation', url: 'https://qbcore.org/docs/' },
  coreObject: { kind: 'doc', label: 'QBCore docs: getting the core object', url: 'https://qbcore.org/docs/qb-core/core-object' },
  qbox: { kind: 'doc', label: 'Qbox documentation', url: 'https://docs.qbox.re/' },
  qboxConvert: { kind: 'doc', label: 'Qbox docs: converting QBCore scripts', url: 'https://docs.qbox.re/migrating/converting-resources' },
  oxmysql: { kind: 'doc', label: 'oxmysql documentation', url: 'https://overextended.dev/docs/oxmysql' },
  oxlib: { kind: 'doc', label: 'ox_lib documentation', url: 'https://overextended.dev/docs/ox_lib' },
  mariadb: { kind: 'doc', label: 'MariaDB error reference', url: 'https://mariadb.com/docs/server/reference/error-codes' },
  portal: { kind: 'doc', label: 'Cfx.re Portal: your keys and assets', url: 'https://portal.cfx.re/' },
  escrow: { kind: 'doc', label: 'Guide: fixing the entitlement error', url: 'https://docs.otherplanet.dev/troubleshooting/you-lack-the-required-entitlement' },
};

const video = (terms) => ({ kind: 'video', label: 'Find videos on YouTube', url: `https://www.youtube.com/results?search_query=${enc(`fivem ${terms}`)}` });
const forum = (terms) => ({ kind: 'forum', label: 'Search the FiveM forum', url: `https://forum.cfx.re/search?q=${enc(terms)}` });

const FRAMEWORKS = {
  vrp: 'vRP', es_extended: 'ESX', ox_core: 'ox_core', qbx_core: 'Qbox', nd_core: 'ND Core',
};

/** What a Lua compile error means, for the save check and for log errors alike. */
export function luaPlain(message = '') {
  const m = String(message);
  if (/invalid escape sequence/.test(m)) return 'A piece of text contains a backslash (\\) that Lua can\'t read. This usually happens with Windows paths like "C:\\Users".';
  if (/unfinished string/.test(m)) return 'A piece of text was opened with a quote mark but never closed.';
  if (/'end' expected/.test(m)) return 'A block of code is missing its closing "end".';
  if (/'\}' expected/.test(m)) return 'A list started with { is missing its closing }, or a comma is missing between two items.';
  if (/'\)' expected/.test(m)) return 'A bracket ( was opened but never closed.';
  if (/'=' expected|'=' or 'in' expected/.test(m)) return 'A line looks like a setting, but its = sign is missing or something before it is mistyped.';
  if (/unexpected symbol/.test(m)) return 'There is a character here that does not belong, often a stray comma, quote or bracket.';
  if (/near <eof>|near '<eof>'/.test(m)) return 'The file ends too early, so something opened earlier was never closed.';
  return 'The code on this line could not be understood.';
}

function runtimeHint(message = '', resource = '', framework = null) {
  const m = String(message);
  let match = m.match(/attempt to index a nil value \((?:global|field|local|upvalue) '([\w.]+)'\)/);
  if (match && /^QBCore$/i.test(match[1])) {
    if (framework === 'qbox') {
      return {
        what: `${resource} used QBCore before it was available. On Qbox, QBCore scripts get it from Qbox's QBCore bridge.`,
        fix: [
          `Check that qbx_core is running and starts before ${resource}.`,
          'Check that server.cfg doesn\'t turn the bridge off: qbx:enableBridge must not be "false".',
          'Near the top of the script, look for: local QBCore = exports[\'qb-core\']:GetCoreObject(). Qbox answers to that name too.',
        ],
        links: [DOCS.qboxConvert, DOCS.qbox],
        terms: 'qbox attempt to index nil QBCore',
      };
    }
    return {
      what: `${resource} used QBCore before it was available.`,
      fix: [
        `Check that qb-core is running and starts before ${resource}.`,
        'Near the top of the script, look for: local QBCore = exports[\'qb-core\']:GetCoreObject()',
        'If that line is missing, add it, then restart the resource.',
      ],
      links: [DOCS.coreObject],
      terms: 'qbcore attempt to index nil QBCore',
    };
  }
  if (match) {
    return {
      what: `It tried to use "${match[1]}", but that didn't exist at that moment. Common causes are a missing setting, a player who has left, or a resource written for a different framework.`,
      fix: ['Open the file at the line shown and see what uses that name.', 'Check the resource\'s config for a blank or missing setting.', 'If this started after an update, restore the previous version from Backups.'],
      links: [DOCS.lua],
      terms: 'attempt to index a nil value',
    };
  }
  match = m.match(/attempt to call a nil value \((?:global|field|method|local|upvalue) '([\w.]+)'\)/);
  if (match) {
    return {
      what: framework === 'qbox'
        ? `It called a function named "${match[1]}" that doesn't exist. The resource may be written for QBCore and use something Qbox's QBCore bridge doesn't offer, or something it depends on is missing.`
        : `It called a function named "${match[1]}" that doesn't exist. The resource is usually written for a different version of QBCore, or something it depends on is missing.`,
      fix: ['Check the resource\'s install notes for what it requires.', framework === 'qbox' ? 'Look for a Qbox version of the resource, or update it and qbx_core.' : 'Update the resource, or qb-core if it is older than the resource expects.', 'If you edited the file recently, check the spelling of that name.'],
      links: [framework === 'qbox' ? DOCS.qboxConvert : DOCS.qbcore, DOCS.lua],
      terms: 'attempt to call a nil value',
    };
  }
  if (/attempt to (compare|perform arithmetic|concatenate)/.test(m)) {
    return {
      what: 'It tried to do math or join text with a value that was empty. A config setting or database value is often blank.',
      fix: ['Open the file at the line shown to see which value is involved.', 'Check that value in the resource\'s config.'],
      links: [DOCS.lua],
      terms: 'attempt to perform arithmetic on a nil value',
    };
  }
  return {
    what: 'The script hit an error while running, so that feature may not work.',
    fix: ['Open the file at the line shown.', 'If you changed this file recently, undo it from its Backups.', 'Otherwise, check for an update or ask the resource\'s author.'],
    links: [DOCS.lua],
    terms: 'script error',
  };
}

const openFile = (ctx, resource, file, line, label) => {
  const folder = ctx.folderOf(resource);
  if (!folder || !file) return null;
  return { kind: 'open-file', label: label || (line ? `Open ${file} at line ${line}` : `Open ${file}`), path: `${folder}/${file}`, line };
};
const openResource = (ctx, resource) => (ctx.folderOf(resource) ? { kind: 'open-resource', label: `Open ${resource}`, name: resource } : null);
const installAction = (name) => {
  const source = findInstallSource(name);
  return source ? { kind: 'install', label: `Install ${source.resource || name}`, url: source.url, name } : null;
};

function channelResource(line, ctx) {
  const m = line.match(/^\[\s*(?:script|resources):([\w.-]+)\]/);
  return m ? ctx.resolveName(m[1]) : null;
}

/**
 * Log channels are cut to a fixed width, so "energy-sou" could be several resources. FXServer
 * then writes "Started resource energy-sound (1 warning)" just after, which settles it.
 */
function warningResource(line, lines, i, ctx) {
  const direct = channelResource(line, ctx);
  if (direct) return direct;
  const prefix = line.match(/^\[\s*(?:script|resources):([\w.-]+)\]/)?.[1];
  if (!prefix) return null;
  for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) {
    const started = lines[j].match(/Started resource ([\w.-]+) \(\d+ warning/);
    if (started && started[1].startsWith(prefix)) return started[1];
  }
  return prefix;
}

function nearbyLoadingResource(lines, i) {
  for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
    const m = lines[j].match(/Creating script environments for ([\w.-]+)/);
    if (m) return m[1];
  }
  return null;
}

const finish = (raw, parts) => ({
  severity: 'error',
  fix: [],
  links: [],
  actions: [],
  ...parts,
  actions: (parts.actions || []).filter(Boolean),
  raw,
});

const RULES = [
  {
    id: 'lua-parse',
    test: /Error parsing script @([\w.-]+)\/(\S+?) in resource [\w.-]+: @[^:]+:(\d+): (.*)$/,
    build(m, { ctx, raw }) {
      const [, resource, file, line, message] = m;
      const escape = /invalid escape sequence/.test(message);
      return finish(raw, {
        key: `lua-parse:${resource}:${file}:${line}`,
        resource,
        title: `${resource} has a mistake in ${file}, line ${line}`,
        what: `${luaPlain(message)} The whole file couldn't be read, so this part of ${resource} did not load.`,
        fix: escape
          ? [`Open ${file} at line ${line}.`, 'Find the Windows path in quotes, such as "C:\\Users\\...".', 'Change each \\ to / so it reads "C:/Users/...".', `Save, then restart ${resource}.`]
          : [`Open ${file} at line ${line}.`, 'Look on that line, and the one above it, for a missing quote, comma, bracket or "end".', `Save, which checks the file for you, then restart ${resource}.`],
        actions: [openFile(ctx, resource, file, Number(line))],
        links: [DOCS.lua, video('lua syntax error fix'), forum(escape ? 'invalid escape sequence lua' : 'error parsing script')],
      });
    },
  },
  {
    id: 'load-import',
    test: /Failed to load script @([\w.-]+)\/(\S+?)\.?$/,
    build(m, { ctx, raw, lines, i }) {
      const [, needed, file] = m;
      const owner = nearbyLoadingResource(lines, i) || ctx.currentResource || null;
      const name = owner || 'A resource';
      // On Qbox, qb-core is only a name qbx_core answers to: there is no qb-core folder to load files from.
      if (needed.toLowerCase() === 'qb-core' && ctx.framework === 'qbox') {
        return finish(raw, {
          key: `load-import:${owner}:${needed}`,
          resource: owner,
          title: `${name} loads a file from qb-core, which Qbox doesn't have`,
          what: `It asks for qb-core's ${file}. Qbox runs most QBCore scripts through its QBCore bridge, but it has no qb-core folder, so files loaded straight from qb-core aren't there.`,
          fix: [
            `Look for a Qbox version of ${name}, or a framework setting in its config that you can set to qbx.`,
            `If the line is qb-core's shared/locale.lua, Qbox's guide for converting scripts shows what to use instead.`,
          ],
          actions: [owner ? openFile(ctx, owner, 'fxmanifest.lua', null, 'Open its fxmanifest.lua') : null],
          links: [DOCS.qboxConvert, DOCS.manifest, forum(`${name} qbox`)],
        });
      }
      if (ctx.isInstalled(needed)) {
        return finish(raw, {
          key: `load-import:${owner}:${needed}:${file}`,
          resource: owner,
          title: `${name} couldn't load a file from ${needed}`,
          what: `It asks for ${file} from ${needed}, but that file isn't there. The two resources may be different versions.`,
          fix: [`Check the line that mentions ${needed} in ${name}'s fxmanifest.lua.`, `Update ${needed} to the version ${name} expects.`],
          actions: [owner ? openFile(ctx, owner, 'fxmanifest.lua', null) : null],
          links: [DOCS.manifest, video('failed to load script fxmanifest'), forum('failed to load script')],
        });
      }
      const framework = FRAMEWORKS[needed.toLowerCase()];
      const fw = ctx.framework === 'qbox' ? 'Qbox' : 'QBCore';
      if (framework) {
        return finish(raw, {
          key: `load-import:${owner}:${needed}`,
          severity: 'warning',
          resource: owner,
          title: `${name} asks for a file from ${framework}, which you don't use`,
          what: `Your server runs ${fw}, but ${name} also tries to load ${framework}'s ${file}. If ${name} supports ${fw}, this can be harmless and the rest still runs. Anything that really needs ${framework} won't work.`,
          fix: [
            `Check ${name}'s config for a framework setting, and make sure it allows ${fw}.`,
            `If it works in game, you can remove the warning: open fxmanifest.lua and put -- in front of the @${needed} line.`,
            `If it doesn't work, ask the author for a ${fw} version.`,
          ],
          actions: [owner ? openFile(ctx, owner, 'fxmanifest.lua', null, 'Open its fxmanifest.lua') : null],
          links: [DOCS.manifest, ctx.framework === 'qbox' ? DOCS.qbox : DOCS.qbcore, video(`${framework} script on ${fw.toLowerCase()} server`), forum(`${framework} to ${fw.toLowerCase()}`)],
        });
      }
      return finish(raw, {
        key: `load-import:${owner}:${needed}`,
        resource: owner,
        title: `${name} needs ${needed}, which isn't installed`,
        what: `It tries to load a file from ${needed}, but you don't have that resource, so ${name} may not work properly.`,
        fix: [installAction(needed) ? `Install ${needed} with the button below.` : `Find and install ${needed}; the install notes for ${name} usually say where to get it.`, `Restart ${name}.`],
        actions: [installAction(needed), owner ? openResource(ctx, owner) : null],
        links: [DOCS.resources, video(`install ${needed}`), forum(needed)],
      });
    },
  },
  {
    id: 'load-script',
    test: /Failed to load script (\S+?)\.?$/,
    build(m, { ctx, raw, lines, i }) {
      // The line above already explained this one in detail.
      if (i > 0 && /Error parsing script/.test(lines[i - 1])) return null;
      const owner = nearbyLoadingResource(lines, i) || ctx.currentResource || null;
      return finish(raw, {
        key: `load-script:${owner}:${m[1]}`,
        resource: owner,
        title: `${owner || 'A resource'} couldn't load ${m[1]}`,
        what: 'A file listed in its fxmanifest.lua is missing or has a mistake in it.',
        fix: ['Check that the file exists in the resource\'s folder.', 'If it\'s missing, reinstall the resource.', 'If it exists, open it and look for a typo.'],
        actions: [owner ? openFile(ctx, owner, m[1], null) : null, owner ? openFile(ctx, owner, 'fxmanifest.lua', null) : null],
        links: [DOCS.manifest, video('failed to load script'), forum('failed to load script')],
      });
    },
  },
  {
    id: 'missing-file',
    test: /could not find (\w+) `([^`]+)` \(defined in fxmanifest\.lua:(\d+)\)/,
    build(m, { ctx, raw, line, lines, i }) {
      const resource = warningResource(line, lines, i, ctx);
      return finish(raw, {
        key: `missing-file:${resource}`,
        groupCount: true,
        severity: 'warning',
        resource,
        title: `${resource || 'A resource'} lists files that aren't there`,
        what: `Its fxmanifest.lua mentions ${m[2]}, but no such file exists in the folder. The resource usually still starts, though the missing part won't work.`,
        fix: ['If something is broken in game, reinstall the resource, because the download may be incomplete.', 'If everything works, the author probably left the line in by mistake and you can ignore this or delete that line.'],
        actions: [resource ? openFile(ctx, resource, 'fxmanifest.lua', Number(m[3]), `Open fxmanifest.lua at line ${m[3]}`) : null],
        links: [DOCS.manifest, video('could not find file fxmanifest'), forum('could not find fxmanifest')],
      });
    },
  },
  {
    id: 'sql-query',
    test: /SCRIPT ERROR: ([\w.-]+) was unable to execute a query!/,
    build(m, { ctx, raw, lines, i }) {
      const resource = ctx.resolveName(m[1]) || m[1];
      const following = lines.slice(i + 1, i + 6).join('\n');
      const table = following.match(/Table '[^.']+\.(\w+)' doesn't exist/)?.[1];
      const column = following.match(/Unknown column '([\w.]+)'/)?.[1];
      if (table) {
        return finish(raw, {
          key: `sql-table:${resource}:${table}`,
          needsSqlFor: resource,
          sqlTable: table,
          resource,
          title: `${resource} needs a database table that doesn't exist`,
          what: `It tried to read the table "${table}". This usually means the resource came with a database (.sql) file that was never run.`,
          fix: ['Run its database file with the button below. A backup is made first.', `Restart ${resource}.`, 'If there\'s no button, look for an install guide or .sql file from where you got the resource.'],
          actions: [openResource(ctx, resource)],
          links: [DOCS.oxmysql, DOCS.mariadb, video('import sql database script qbcore'), forum(`${resource} doesn't exist table`)],
        });
      }
      if (column) {
        return finish(raw, {
          key: `sql-column:${resource}:${column}`,
          needsSqlFor: resource,
          // "po.code" is column "code" of whatever table the query called "po".
          sqlColumn: column.split('.').pop(),
          sqlQuery: following,
          resource,
          title: `${resource} expects a database column that doesn't exist`,
          what: `It asked for "${column}", which isn't in your database. A resource update often adds columns through a new .sql file.`,
          fix: ['Look for an update or install .sql file in the resource.', 'Run it with the button below, if there is one. A backup is made first.', `Restart ${resource}.`],
          actions: [openResource(ctx, resource)],
          links: [DOCS.oxmysql, DOCS.mariadb, video('unknown column sql fix'), forum('unknown column')],
        });
      }
      return finish(raw, {
        key: `sql-query:${resource}`,
        resource,
        title: `${resource} had a database error`,
        what: 'A database request failed, so some of its data may not load or save.',
        fix: ['Open the Console page and read the lines just after this error.', 'Check that the resource\'s .sql file has been run.'],
        actions: [openResource(ctx, resource)],
        links: [DOCS.oxmysql, DOCS.mariadb, video('oxmysql query error'), forum('unable to execute a query')],
      });
    },
  },
  {
    id: 'no-export',
    test: /No such export (\w+) in resource ([\w.-]*[\w-])/,
    build(m, { ctx, raw, line }) {
      const [, exportName, target] = m;
      const caller = channelResource(line, ctx);
      const installed = ctx.isInstalled(target);
      return finish(raw, {
        key: `no-export:${target}:${exportName}`,
        resource: caller,
        title: `${caller || 'A resource'} needs "${exportName}" from ${target}`,
        what: installed
          ? `${target} is installed but doesn't provide "${exportName}". It may be stopped, starting too late, or a different version.`
          : `${target} isn't installed, so "${exportName}" isn't available.`,
        fix: installed
          ? [`Check that ${target} is running on the Resources page.`, `Make sure ${target} starts before ${caller || 'the resource that needs it'}.`, `Update ${target} if it's old.`]
          : [`Install ${target}.`, `Restart ${caller || 'the resource that needs it'}.`],
        actions: [installed ? openResource(ctx, target) : installAction(target), caller ? openResource(ctx, caller) : null],
        links: [DOCS.resources, video('no such export in resource'), forum('no such export')],
      });
    },
  },
  {
    id: 'missing-dependency',
    test: /Could not find dependency ([^\s]+) for resource ([\w.-]*[\w-])/,
    build(m, { ctx, raw }) {
      const [, dependency, resource] = m;
      const name = dependency.replace(/^\//, '');
      return finish(raw, {
        key: `missing-dependency:${resource}:${name}`,
        resource,
        title: `${resource} needs ${name}, which is missing`,
        what: `${resource} won't start until ${name} is installed.`,
        fix: [installAction(name) ? `Install ${name} with the button below.` : `Find and install ${name}; ${resource}'s install notes usually link to it.`, `Start ${resource} again.`],
        actions: [installAction(name), openResource(ctx, resource)],
        links: [DOCS.manifest, DOCS.resources, video(`install ${name}`), forum(`could not find dependency ${name}`)],
      });
    },
  },
  {
    id: 'start-failed',
    test: /Couldn't start resource ([\w.-]*[\w-])/,
    build(m, { ctx, raw }) {
      return finish(raw, {
        key: `start-failed:${m[1]}`,
        resource: m[1],
        title: `${m[1]} couldn't start`,
        what: 'The reason is usually in the lines just above this one in the console, such as something it needs being missing.',
        fix: ['Open the Console page and read the lines above this error.', 'Check for other problems listed here that mention this resource.'],
        actions: [openResource(ctx, m[1])],
        links: [DOCS.resources, video('couldn\'t start resource'), forum('couldn\'t start resource')],
      });
    },
  },
  {
    id: 'unknown-resource',
    test: /Couldn't find resource ([\w.-]*[\w-])/,
    build(m, { ctx, raw }) {
      const line = ctx.cfgLineOf(m[1]);
      return finish(raw, {
        key: `unknown-resource:${m[1]}`,
        severity: 'warning',
        title: `server.cfg starts "${m[1]}", but it doesn't exist`,
        what: 'There\'s a line in server.cfg for a resource that isn\'t in your resources folder, so it is skipped.',
        fix: [`If you meant to install ${m[1]}, install it.`, 'Check the spelling matches the folder name exactly.', 'Otherwise, delete that line from server.cfg.'],
        actions: [{ kind: 'open-file', label: 'Open server.cfg', path: 'server.cfg', line: line || undefined }],
        links: [DOCS.commands, video('couldn\'t find resource server.cfg'), forum('couldn\'t find resource')],
      });
    },
  },
  {
    id: 'entitlement',
    test: /lack the required entitlement|Failed to verify protected resource/,
    build(_m, { ctx, raw, line }) {
      const resource = channelResource(line, ctx) || line.match(/(?:to use|resource) ([\w.-]+)/)?.[1];
      return finish(raw, {
        key: `entitlement:${resource}`,
        resource,
        title: `${resource || 'A paid resource'} isn't licensed to your server`,
        what: 'This resource is encrypted and tied to the Cfx.re account that bought it. Your server\'s license key has to come from that same account.',
        fix: ['Sign in at the Cfx.re Portal and check which account owns this resource.', 'Use a license key from that account, or transfer the resource to the account that owns your key.', 'Don\'t rename the resource\'s folder, since that causes this error too.', 'Fully restart the server after changing anything.'],
        links: [DOCS.escrow, DOCS.portal, video('you lack the required entitlement'), forum('lack the required entitlement')],
      });
    },
  },
  {
    id: 'database-connect',
    test: /ECONNREFUSED|ER_ACCESS_DENIED|Access denied for user|Can't connect to (?:MySQL|server)/,
    build(_m, { raw, lines, i }) {
      // Only other services use these words too; this is about the database.
      if (!/oxmysql|mysql|mariadb|3308|3306|STDERR/i.test(raw)) return null;
      // It connected afterwards, so this is already over.
      if (lines.slice(i + 1).some((l) => /Database server connection established/.test(l))) return null;
      return finish(raw, {
        key: 'database-connect',
        title: 'The server can\'t reach its database',
        what: 'QBCore stores characters, money and items in the database. Without it, players can\'t load in and nothing is saved.',
        fix: ['Restart the server from Home, which starts the database too.', 'If it keeps happening, check the database line in server.cfg hasn\'t changed.'],
        links: [DOCS.oxmysql, DOCS.mariadb, video('oxmysql connection error fix'), forum('oxmysql ECONNREFUSED')],
      });
    },
  },
  {
    id: 'license-key',
    test: /(?:invalid|no valid|missing).{0,30}license key|license key.{0,30}(?:invalid|expired|not valid)|sv_licenseKey.{0,40}(?:not|missing|invalid)|could not authenticate server license key/i,
    build(_m, { raw }) {
      // Since October 2026, a key without the server's details on the Portal is inactive.
      const inactive = /inactive/i.test(raw);
      return finish(raw, {
        key: 'license-key',
        title: inactive ? 'Your license key is inactive' : 'There is a problem with your license key',
        what: inactive
          ? 'FiveM refused the key, so the server can\'t start. Since October 2026, a key only works once the server\'s details are filled in on the Cfx.re Portal.'
          : 'FiveM servers need a valid key from the Cfx.re Portal to start.',
        fix: inactive
          ? ['Sign in at the Cfx.re Portal with the account the key comes from, and open Servers, then Server Registration Keys.', 'Open the key in server.cfg, choose Edit Server Details, and fill in Name, Tagline, Description and Language. Save, and activate the key if the Portal asks.', 'Restart the server.']
          : ['Sign in at the Cfx.re Portal and check your key is still valid.', 'If you need a new one, create it there and put it in server.cfg.', 'Restart the server.'],
        links: [DOCS.portal, DOCS.setup, video('server license key'), forum('license key invalid')],
      });
    },
  },
  {
    id: 'script-error',
    test: /SCRIPT ERROR: @([\w.-]+)\/(\S+?):(\d+): (.*)$/,
    build(m, { ctx, raw }) {
      const [, resource, file, line, message] = m;
      const hint = runtimeHint(message, resource, ctx.framework);
      return finish(raw, {
        key: `script-error:${resource}:${file}:${line}`,
        resource,
        title: `${resource} hit an error in ${file}, line ${line}`,
        what: hint.what,
        fix: hint.fix,
        actions: [openFile(ctx, resource, file, Number(line))],
        links: [...hint.links, video(hint.terms), forum(hint.terms)],
      });
    },
  },
  {
    id: 'script-error-plain',
    test: /SCRIPT ERROR:/,
    build(_m, { ctx, raw, line }) {
      const resource = channelResource(line, ctx);
      return finish(raw, {
        key: `script-error-plain:${resource}:${raw.replace(/\d+/g, '#').slice(0, 80)}`,
        resource,
        title: `${resource || 'A resource'} hit an error`,
        what: 'A script stopped because of an error, so that feature may not work.',
        fix: ['Open the Console page to see the lines around this error.', 'If you changed this resource recently, undo it from its Backups.'],
        actions: [resource ? openResource(ctx, resource) : null],
        links: [DOCS.lua, video('script error'), forum('script error')],
      });
    },
  },
  {
    id: 'oversized-asset',
    test: /Asset ([\w.-]+)\/\S+ uses ([\d.]+) MiB of (?:physical|virtual) memory/,
    build(m, { raw, ctx }) {
      const resource = ctx.resolveName(m[1]) || m[1];
      return finish(raw, {
        key: `oversized:${resource}`,
        severity: 'warning',
        resource,
        title: `${resource} has very large game files`,
        what: OVERSIZED_WHAT,
        fix: OVERSIZED_FIX,
        links: OVERSIZED_LINKS,
      });
    },
  },
];

/** One card for all oversized files, so a few big map packs don't bury everything else. */
function mergeOversized(items) {
  const group = items.filter((i) => i.rule === 'oversized-asset');
  if (group.length < 2) return items;
  const total = group.reduce((sum, i) => sum + i.count, 0);
  const names = group.map((i) => i.resource);
  const shown = names.slice(0, 6).join(', ') + (names.length > 6 ? ` and ${names.length - 6} more` : '');
  return [
    ...items.filter((i) => i.rule !== 'oversized-asset'),
    {
      ...group[0],
      id: 'oversized:all',
      resource: null,
      count: total,
      title: `${names.length} resources have very large game files`,
      what: `${shown}. ${OVERSIZED_WHAT}`,
      raw: `${total} oversized files. For example: ${group[0].raw}`,
    },
  ];
}

const OVERSIZED_WHAT = 'FiveM warns that oversized models and textures can stop things appearing properly, cause flickering, or crash players with less powerful PCs. Everything can still run fine on a strong PC.';
const OVERSIZED_FIX = ['If players report missing textures or crashes around these, ask the author for an optimized version.', 'Or shrink the textures with a texture tool, if you\'re comfortable doing that.', 'If nobody has trouble, you can leave them.'];
const OVERSIZED_LINKS = [DOCS.resources, video('oversized assets optimize ytd textures'), forum('oversized assets streaming')];

const STACK_LINE = /^\[[^\]]*\]\s*>\s/;

/** Explains one error for the save-and-restart flow, or a set of log lines for the Overview. */
export function explainLogLines(lines, ctx) {
  const seen = new Map();
  lines.forEach((line, i) => {
    if (STACK_LINE.test(line)) return;
    for (const rule of RULES) {
      const m = line.match(rule.test);
      if (!m) continue;
      const raw = line.replace(/^\[\s+/, '[');
      const item = rule.build(m, { ctx, raw, line, lines, i });
      if (item) {
        const existing = seen.get(item.key);
        if (existing) existing.count += 1;
        else seen.set(item.key, { ...item, id: item.key, rule: rule.id, count: 1 });
      }
      return;
    }
  });
  const items = mergeOversized([...seen.values()]);
  for (const item of items) {
    if (item.groupCount && item.count > 1) item.title = `${item.title} (${item.count} found)`;
    delete item.groupCount;
  }
  return items.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
}

/** The same format for a dependency the Resources page already knows is missing. */
export function explainMissingDependency(resource, dependency, ctx) {
  const install = installAction(dependency);
  return {
    id: `missing-dependency:${resource}:${dependency}`,
    rule: 'missing-dependency',
    severity: 'error',
    resource,
    count: 1,
    title: `${resource} needs ${dependency}, which is missing`,
    what: `${resource} won't start properly until ${dependency} is installed.`,
    fix: [install ? `Install ${dependency} with the button below.` : `Find and install ${dependency}; ${resource}'s install notes usually link to it.`, `Start ${resource} again.`],
    actions: [install, openResource(ctx, resource)].filter(Boolean),
    links: [DOCS.manifest, DOCS.resources, video(`install ${dependency}`), forum(`${dependency} dependency`)],
    raw: `${resource} depends on ${dependency}`,
  };
}
