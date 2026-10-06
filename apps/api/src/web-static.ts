import { existsSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/** Files the Angular build names with a content hash (main-ABC123.js, chunk-ABC123.js, styles). */
const HASHED_FILE = /-[A-Za-z0-9_]{8,}\.(?:js|css|woff2?|png|jpe?g|svg|webp|ico)$/;
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

export function pathnameOf(request: FastifyRequest): string {
  return request.url.split('?')[0] ?? '/';
}

export function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** True when the folder holds a build (an index.html); otherwise the API serves no web at all. */
export function hasWebBuild(webDir: string | null): boolean {
  return webDir !== null && existsSync(join(resolve(webDir), 'index.html'));
}

/**
 * Serves the compiled web from the API (production: one process behind Funnel). It uses the not-found
 * handler instead of routes, so the public allowlist of the guard stays at the login steps and health.
 * Returns whether it is serving: without a folder (or without index.html) nothing changes.
 */
export function registerWebStatic(app: FastifyInstance, webDir: string | null): boolean {
  if (!hasWebBuild(webDir) || webDir === null) return false;
  const root = resolve(webDir);

  void app.register(fastifyStatic, { root, serve: false, cacheControl: false });

  app.setNotFoundHandler(async (request, reply) => {
    const pathname = pathnameOf(request);
    const isRead = request.method === 'GET' || request.method === 'HEAD';
    // An unknown API path is a 404 (the guard already asked for a session), never the web.
    if (!isRead || isApiPath(pathname)) return reply.code(404).send({ error: 'not_found' });

    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return reply.code(400).send({ error: 'bad_request' });
    }
    const candidate = resolve(root, `.${decoded}`);
    const inside = candidate === root || candidate.startsWith(root + sep);
    const asset = inside && decoded !== '/' && isFile(candidate);
    const file = asset ? relative(root, candidate) : 'index.html';
    const hashed = asset && HASHED_FILE.test(file);
    return reply
      .header(
        'cache-control',
        hashed ? `public, max-age=${String(ONE_YEAR_SECONDS)}, immutable` : 'no-cache',
      )
      .sendFile(file);
  });
  return true;
}

/** True for the GETs the web handler answers: the guard lets them through without a session. */
export function isWebRequest(request: FastifyRequest): boolean {
  return (request.method === 'GET' || request.method === 'HEAD') && !isApiPath(pathnameOf(request));
}
