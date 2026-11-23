import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

// Static assets for the dashboard (self-hosted fonts, so no CDN dependency and no external requests).
const ALLOWED = new Map<string, { file: string; type: string }>([
  ['plus-jakarta-sans-latin.woff2', { file: 'plus-jakarta-sans-latin.woff2', type: 'font/woff2' }],
  ['plus-jakarta-sans-latin-ext.woff2', { file: 'plus-jakarta-sans-latin-ext.woff2', type: 'font/woff2' }],
]);

const ASSETS_DIR = path.join(import.meta.dirname, 'assets', 'fonts');

export function registerDashboardAssets(app: FastifyInstance) {
  app.get<{ Params: { file: string } }>('/assets/:file', async (req, reply) => {
    const entry = ALLOWED.get(req.params.file);
    if (!entry) return reply.code(404).send({ ok: false });
    try {
      const body = await readFile(path.join(ASSETS_DIR, entry.file));
      return reply.header('content-type', entry.type)
        .header('cache-control', 'public, max-age=31536000, immutable')
        .header('cross-origin-resource-policy', 'same-origin')
        .send(body);
    } catch {
      return reply.code(404).send({ ok: false });
    }
  });
}
