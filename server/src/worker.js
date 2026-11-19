// Cloudflare entry point.
//  - The screens (client/dist) are served by Cloudflare's static assets.
//  - Every /api request goes to ONE Durable Object, which holds the factory's
//    SQLite database and runs the same app as the computer version.
import { DurableObject } from 'cloudflare:workers';

export class ErpDatabase extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    globalThis.__ERP_STORAGE = ctx.storage; // used by driver.worker.js (always the live instance)
  }

  async fetch(request) {
    globalThis.__ERP_STORAGE = this.ctx.storage;
    if (!this.app) {
      const { createApp } = await import('./app.js');
      this.app = createApp();
    }
    return this.app.fetch(request);
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      return env.ERP.get(env.ERP.idFromName('factory')).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
