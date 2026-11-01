/**
 * CLI Command: baton hooks
 *
 * Manage hook installations across agents.
 *
 * Usage:
 *   baton hooks install [--agent <name>] [--global]
 *   baton hooks preview [--agent <name>] [--global]
 *   baton hooks uninstall [--agent <name>] [--global]
 *   baton hooks status
 */

import { defineCommand } from 'citty';

export default defineCommand({
  meta: {
    name: 'hooks',
    description: 'Manage automatic memory hooks for agents',
  },
  subCommands: {
    install: () => import('./hooks-install.js').then((m) => m.default),
    preview: () => import('./hooks-preview.js').then((m) => m.default),
    uninstall: () => import('./hooks-uninstall.js').then((m) => m.default),
    status: () => import('./hooks-status.js').then((m) => m.default),
  },
  run() {
    // Default: show help
  },
});
