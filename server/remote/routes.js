// Routes for hosted servers. Registered before the local ones: on a hosted server these answer
// instead, and what isn't available yet says so plainly. Connecting one (on the Welcome screen)
// works in either mode.
import { agentRequest } from '../agent.js';
import { HttpError, REMOTE } from '../paths.js';
import {
  browseFolder, fileDetails, listFiles, listVersions, readEditable, restoreVersion, saveContent, saveFields, sendRaw,
} from './files.js';
import { connection } from './connection.js';
import { hostedResourceAction, listHostedResources, setHostedBoot } from './resources.js';
import { checkHosted, listPanelServers, useHosted } from './welcome.js';

// Pages that work on files, processes or Windows on this PC, and so not for a hosted server yet.
const NOT_YET = [
  /^\/problems/, /^\/health/, /^\/reach/, /^\/profile/, /^\/backups/, /^\/trash/,
  /^\/resources\/install/, /^\/resources\/[^/]+\/(check|restart-checked|sql-files|sql|activate)/,
  /^\/server\/(start-panel|pin)/, /^\/browse\/search/,
];

export function registerHostedRoutes(api, { json, handler, localOnly, relaunchSoon }) {
  // Connecting a hosted server, from the Welcome screen or Settings. Only on the PC itself: the
  // key or password never comes from, or goes to, a phone.
  api.post('/welcome/hosted/servers', localOnly, json, handler((req) => listPanelServers(req.body)));
  api.post('/welcome/hosted/check', localOnly, json, handler((req) => checkHosted(req.body)));
  api.post('/welcome/hosted/use', localOnly, json, handler(async (req) => {
    const saved = await useHosted(req.body);
    return { ...saved, relaunching: relaunchSoon() };
  }));

  if (!REMOTE) return;

  api.use((req, res, next) => {
    if (NOT_YET.some((re) => re.test(req.path)) || (req.method === 'DELETE' && /^\/resources\/[^/]+$/.test(req.path))) {
      return res.status(409).json({ error: 'This isn\'t available for hosted servers yet. It\'s coming in a later version of CityHQ.', hostedNotYet: true });
    }
    return next();
  });

  // Console: commands go through the panel when there is one (it works even while the helper is
  // starting), otherwise through the helper.
  api.post('/console/command', json, handler(async (req) => {
    const command = typeof req.body?.command === 'string' ? req.body.command.trim().slice(0, 500) : '';
    if (!command) throw new HttpError(400, 'Type a command first');
    const conn = connection();
    if (conn.command) { await conn.command(command); return { ran: command }; }
    return agentRequest('/command', { method: 'POST', body: { command } });
  }));

  // Resources
  api.get('/resources', handler(() => listHostedResources()));
  api.post('/resources/:name/action', json, handler((req) => hostedResourceAction(req.params.name, req.body?.action)));
  api.post('/resources/:name/boot', json, handler((req) => setHostedBoot(req.params.name, Boolean(req.body?.enabled))));

  // The file editor and the Files page
  const args = (source) => {
    const { scope, path: rel } = source;
    if (typeof scope !== 'string' || !scope) throw new HttpError(400, 'Missing scope');
    if (rel !== undefined && typeof rel !== 'string') throw new HttpError(400, 'Invalid path');
    return { scope, rel };
  };
  api.get('/files', handler((req) => listFiles(args(req.query).scope)));
  api.get('/file', handler((req) => { const { scope, rel } = args(req.query); return readEditable(scope, rel); }));
  api.put('/file', json, handler((req) => { const { scope, rel } = args(req.body); return saveContent(scope, rel, req.body.content, req.body.etag, { force: req.body.force === true }); }));
  api.put('/file/fields', json, handler((req) => { const { scope, rel } = args(req.body); return saveFields(scope, rel, req.body.changes, req.body.etag, { force: req.body.force === true }); }));
  api.get('/file/versions', handler((req) => { const { scope, rel } = args(req.query); return listVersions(scope, rel); }));
  api.post('/file/restore', json, handler((req) => { const { scope, rel } = args(req.body); return restoreVersion(scope, rel, req.body.id); }));
  api.get('/browse', handler((req) => browseFolder(req.query.path ?? '')));
  api.get('/browse/info', handler((req) => fileDetails(req.query.path)));
  api.get('/browse/raw', handler((req, res) => sendRaw(res, req.query.path, req.query.download === '1')));
}
