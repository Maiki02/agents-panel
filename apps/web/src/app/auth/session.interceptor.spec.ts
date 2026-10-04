import { HttpErrorResponse } from '@angular/common/http';
import { describe, expect, it } from 'vitest';
import { isExpiredSession } from './session.interceptor';

const failure = (status: number, error: unknown) => new HttpErrorResponse({ status, error });

describe('isExpiredSession', () => {
  it('treats 401 unauthorized as an expired session', () => {
    expect(isExpiredSession(failure(401, { error: 'unauthorized' }), '/api/chats')).toBe(true);
  });

  it('does not treat 401 invalid_totp as an expired session', () => {
    expect(isExpiredSession(failure(401, { error: 'invalid_totp' }), '/api/projects/1/env')).toBe(
      false,
    );
  });

  it('ignores other statuses and non-HTTP errors', () => {
    expect(isExpiredSession(failure(403, { error: 'unauthorized' }), '/api/chats')).toBe(false);
    expect(isExpiredSession(failure(409, null), '/api/chats')).toBe(false);
    expect(isExpiredSession(new Error('boom'), '/api/chats')).toBe(false);
  });

  it('never redirects on /api/auth/* so the login shows its own error', () => {
    expect(isExpiredSession(failure(401, { error: 'unauthorized' }), '/api/auth/totp')).toBe(false);
  });
});
