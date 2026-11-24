import { copyFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDirectory = path.join(projectRoot, 'artifacts', 'build', 'windows');
const installerPattern = /^Multi-AI-Aggregator-Setup-.*\.exe$/i;

const entries = await readdir(buildDirectory, { withFileTypes: true });
const installers = await Promise.all(
  entries
    .filter((entry) => entry.isFile() && installerPattern.test(entry.name))
    .map(async (entry) => ({
      name: entry.name,
      path: path.join(buildDirectory, entry.name),
      modifiedAt: (await stat(path.join(buildDirectory, entry.name))).mtimeMs,
    })),
);

if (installers.length === 0) {
  throw new Error(`Windows installer was not found in ${buildDirectory}`);
}

installers.sort((a, b) => b.modifiedAt - a.modifiedAt);
const installer = installers[0];
const destination = path.join(projectRoot, installer.name);

// Keep the project root unambiguous: remove only previous generated installers.
const rootEntries = await readdir(projectRoot, { withFileTypes: true });
for (const entry of rootEntries) {
  if (entry.isFile() && installerPattern.test(entry.name) && entry.name !== installer.name) {
    await rm(path.join(projectRoot, entry.name), { force: true });
  }
}

await copyFile(installer.path, destination);
console.log(`Windows installer is ready: ${installer.name}`);
console.log(destination);
