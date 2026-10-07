import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { createBrotliCompress, createGzip } from 'node:zlib';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

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

const COMPRESS_MIN_BYTES = 1024;
/** Text types of the web build worth compressing (images and fonts are already packed). */
const COMPRESSIBLE_FILES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Sends a text file of the web build as br or gzip when the client accepts it. The not-found
 * handler is not a route, so @fastify/compress never sees it: this does the same by hand for the
 * web files. Returns undefined when the file is not eligible (the caller sends it as is).
 */
function sendCompressed(
  request: FastifyRequest,
  reply: FastifyReply,
  path: string,
): FastifyReply | undefined {
  const type = COMPRESSIBLE_FILES[extname(path).toLowerCase()];
  const accept = request.headers['accept-encoding'] ?? '';
  const encoding = /\bbr\b/u.test(accept) ? 'br' : /\bgzip\b/u.test(accept) ? 'gzip' : null;
  if (type === undefined || encoding === null) return undefined;
  try {
    if (statSync(path).size < COMPRESS_MIN_BYTES) return undefined;
  } catch {
    return undefined;
  }
  const packer = encoding === 'br' ? createBrotliCompress() : createGzip();
  return reply
    .type(type)
    .header('content-encoding', encoding)
    .header('vary', 'Accept-Encoding')
    .send(createReadStream(path).pipe(packer));
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
    void reply.header(
      'cache-control',
      hashed ? `public, max-age=${String(ONE_YEAR_SECONDS)}, immutable` : 'no-cache',
    );
    return sendCompressed(request, reply, join(root, file)) ?? reply.sendFile(file);
  });
  return true;
}

/** True for the GETs the web handler answers: the guard lets them through without a session. */
export function isWebRequest(request: FastifyRequest): boolean {
  return (request.method === 'GET' || request.method === 'HEAD') && !isApiPath(pathnameOf(request));
}
