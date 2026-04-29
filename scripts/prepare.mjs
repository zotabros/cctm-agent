#!/usr/bin/env node
// Build dist/ from src/ when installed from git/local. Skip if no source
// (registry tarball ships dist/ already and doesn't include src/).
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(process.cwd());
if (!existsSync(resolve(root, 'src/index.ts')) || !existsSync(resolve(root, 'tsconfig.json'))) {
  process.exit(0);
}

const localTsc = resolve(root, 'node_modules/.bin/tsc');
const args = ['-p', 'tsconfig.json'];

let cmd, cmdArgs;
if (existsSync(localTsc)) {
  cmd = localTsc;
  cmdArgs = args;
} else {
  cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  cmdArgs = ['--yes', '-p', 'typescript@^5.6.3', '--', 'tsc', ...args];
}

const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', cwd: root, shell: false });
process.exit(r.status ?? 1);
