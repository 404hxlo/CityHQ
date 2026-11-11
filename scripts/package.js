// Builds the Windows app into control-app\release\CityHQ-win32-x64.
import { packager } from '@electron/packager';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// setup\ goes along so the Welcome screen can build a new server from a downloaded copy.
const KEEP = [/^\/package\.json$/, /^\/LICENSE\.md$/, /^\/electron(\/|$)/, /^\/server(\/|$)/, /^\/dist(\/|$)/, /^\/agent-resource(\/|$)/, /^\/build(\/|$)/, /^\/setup(\/|$)/, /^\/node_modules(\/|$)/];

const paths = await packager({
  dir: root,
  // QBC_PACKAGE_OUT builds a test copy elsewhere, leaving the installed app (and its open files) alone.
  out: process.env.QBC_PACKAGE_OUT ? path.resolve(process.env.QBC_PACKAGE_OUT) : path.join(root, 'release'),
  name: 'CityHQ',
  executableName: 'CityHQ',
  platform: 'win32',
  arch: 'x64',
  overwrite: true,
  asar: false,
  prune: true,
  icon: path.join(root, 'build', 'icon.ico'),
  appCopyright: 'Copyright (c) 2026 404hxlo. PolyForm Shield License 1.0.0',
  win32metadata: { FileDescription: 'CityHQ', ProductName: 'CityHQ' },
  ignore: (file) => file !== '' && !KEEP.some((re) => re.test(file.replaceAll('\\', '/'))),
});
console.log(`Packaged to ${paths.join(', ')}`);
