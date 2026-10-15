import type { FetchLike } from '../src/forge/gitlab-api.js';

export interface FakeMr {
  iid: number;
  project: string;
  source_branch: string;
  target_branch: string;
  state: 'opened' | 'merged' | 'closed' | 'locked';
  title: string;
  description: string;
}

export interface FakeCall {
  method: string;
  url: string;
  token: string | null;
  redirect: RequestInit['redirect'];
  hasSignal: boolean;
  body: unknown;
}

/** An in-memory GitLab REST v4 (merge requests only): tests never touch the network. */
export function fakeGitlab(host: string, token: string) {
  const mrs: FakeMr[] = [];
  const calls: FakeCall[] = [];
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const view = (mr: FakeMr) => ({
    iid: mr.iid,
    state: mr.state,
    title: mr.title,
    description: mr.description,
    web_url: `https://${host}/${mr.project}/-/merge_requests/${String(mr.iid)}`,
  });
  const fetchImpl: FetchLike = (rawUrl, init) => {
    const url = new URL(rawUrl);
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({
      method: init.method ?? 'GET',
      url: rawUrl,
      token: headers.get('PRIVATE-TOKEN'),
      redirect: init.redirect,
      hasSignal: init.signal !== undefined && init.signal !== null,
      body,
    });
    if (url.host !== host) return Promise.reject(new Error(`unexpected host ${url.host}`));
    if (headers.get('PRIVATE-TOKEN') !== token) {
      return Promise.resolve(json(401, { message: `401 Unauthorized (token ${token} rejected)` }));
    }
    const list = /^\/api\/v4\/projects\/([^/]+)\/merge_requests$/.exec(url.pathname);
    const one = /^\/api\/v4\/projects\/([^/]+)\/merge_requests\/(\d+)$/.exec(url.pathname);
    if (list?.[1] !== undefined) {
      const project = decodeURIComponent(list[1]);
      if ((init.method ?? 'GET') === 'POST') {
        const input = body as {
          source_branch: string;
          target_branch: string;
          title: string;
          description: string;
        };
        const mr: FakeMr = {
          iid: mrs.length + 1,
          project,
          source_branch: input.source_branch,
          target_branch: input.target_branch,
          state: 'opened',
          title: input.title,
          description: input.description,
        };
        mrs.push(mr);
        return Promise.resolve(json(201, view(mr)));
      }
      const q = url.searchParams;
      const state = q.get('state');
      const found = mrs.filter(
        (mr) =>
          mr.project === project &&
          (q.get('source_branch') === null || mr.source_branch === q.get('source_branch')) &&
          (q.get('target_branch') === null || mr.target_branch === q.get('target_branch')) &&
          (state === 'all' || state === null || mr.state === state),
      );
      return Promise.resolve(json(200, found.map(view)));
    }
    if (one?.[1] !== undefined && one[2] !== undefined) {
      const mr = mrs.find(
        (m) => m.project === decodeURIComponent(one[1] ?? '') && m.iid === Number(one[2]),
      );
      return Promise.resolve(mr ? json(200, view(mr)) : json(404, { message: '404 Not found' }));
    }
    return Promise.resolve(json(404, { message: '404 Not found' }));
  };
  return { fetchImpl, mrs, calls };
}
