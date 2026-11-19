// Computer version: one Node process serves the API and the built screens on one port.
import express from 'express';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp as createSharedApp } from './app.js';

export { clientIp } from './app.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  return createSharedApp({
    extra(app) {
      // Serve the built React app (single process, single port in production)
      const dist = path.join(here, '..', '..', 'client', 'dist');
      if (fs.existsSync(dist)) {
        app.use(express.static(dist, { index: false, maxAge: '1h' }));
        app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
      }
    },
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 4000;
  createApp().listen(port, '0.0.0.0', () => {
    console.log(`Soap Factory ERP running on http://localhost:${port}`);
    for (const ifs of Object.values(os.networkInterfaces()).flat()) {
      if (ifs?.family === 'IPv4' && !ifs.internal) console.log(`  On factory Wi-Fi:  http://${ifs.address}:${port}`);
    }
  });
}
