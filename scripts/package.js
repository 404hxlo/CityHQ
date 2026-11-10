// Builds the Windows app into control-app\release\CityHQ-win32-x64.
import { packager } from '@electron/packager';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP = [/^\/package\.json$/, /^\/electron(\/|$)/, /^\/server(\/|$)/, /^\/dist(\/|$)/, /^\/agent-resource(\/|$)/, /^\/build(\/|$)/, /^\/node_modules(\/|$)/];

const paths = await packager({
  dir: root,
  out: path.join(root, 'release'),
  name: 'CityHQ',
  executableName: 'CityHQ',
  platform: 'win32',
  arch: 'x64',
  overwrite: true,
  asar: false,
  prune: true,
  icon: path.join(root, 'build', 'icon.ico'),
  appCopyright: 'Personal use',
  win32metadata: { FileDescription: 'CityHQ', ProductName: 'CityHQ' },
  ignore: (file) => file !== '' && !KEEP.some((re) => re.test(file.replaceAll('\\', '/'))),
});
console.log(`Packaged to ${paths.join(', ')}`);
