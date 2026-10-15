// OWNER: WP0 — entry point (`npm start`): starts Scrolls on 127.0.0.1:3460 (SPEC D12)
//
// Prints one JSON line {"event":"listening","url":…} on stdout (tests and scripts wait for it), then a
// human-readable line. Exit codes: 2 = E_DB_IN_ICLOUD, 3 = port in use, 1 = any other startup failure.

import { startServer } from './server/http/app.mjs';

let handle = null;

async function shutdown(signal) {
  if (!handle) process.exit(0);
  const timer = setTimeout(() => process.exit(1), 8000);
  timer.unref();
  try {
    await handle.close();
  } finally {
    process.stderr.write(`Scrolls stopped (${signal}).\n`);
    process.exit(0);
  }
}

try {
  handle = await startServer();
  process.stdout.write(`${JSON.stringify({ event: 'listening', url: handle.url, pid: process.pid })}\n`);
  process.stdout.write(`Scrolls is running at ${handle.url}/\n`);
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
} catch (err) {
  if (err?.code === 'E_DB_IN_ICLOUD') {
    process.stderr.write(`E_DB_IN_ICLOUD: ${err.message}\n`);
    process.exit(2);
  }
  if (err?.code === 'EADDRINUSE') {
    process.stderr.write(`E_PORT_IN_USE: port ${err.port ?? ''} is taken (is Scrolls already running?). Set SCROLLS_PORT to use another.\n`);
    process.exit(3);
  }
  process.stderr.write(`Scrolls failed to start: ${err?.stack ?? err}\n`);
  process.exit(1);
}
