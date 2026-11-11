// Runs SQL against the server's own database with the mariadb client, using server.cfg's connection.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { connectionStringOf, parseConnection, readCfg } from './cfg.js';
import { clientArgs, clientEnv, dbClient } from './dbtools.js';
import { findServerData, HttpError } from './paths.js';

const exec = promisify(execFile);
export const VALID_TABLE = /^\w{1,64}$/;

/** Runs SQL and returns the rows, each a list of column values. */
export async function dbRun(sql, { timeoutMs = 30000 } = {}) {
  const server = findServerData();
  if (!server) throw new HttpError(409, 'The server has not been deployed yet.');
  const conn = parseConnection(connectionStringOf(await readCfg(server.cfgPath)));
  if (!conn?.database) throw new HttpError(400, 'Could not read the database settings from server.cfg');
  const { stdout } = await exec(dbClient(), [
    ...clientArgs(conn), conn.database, '--batch', '--skip-column-names', '--execute', sql,
  ], { env: clientEnv(conn), windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  return stdout.split(/\r?\n/).filter(Boolean).map((line) => line.split('\t'));
}

/** A table's columns and row count, or null when it doesn't exist. */
export async function tableInfo(table) {
  if (!VALID_TABLE.test(table)) throw new HttpError(400, 'Invalid table name');
  const columns = await dbRun(`SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = '${table}' ORDER BY ordinal_position`);
  if (!columns.length) return null;
  const [[rows]] = await dbRun(`SELECT COUNT(*) FROM \`${table}\``);
  return { columns: columns.map((c) => c[0]), rows: Number(rows) };
}
