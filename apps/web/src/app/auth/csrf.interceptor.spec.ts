import { HttpRequest } from '@angular/common/http';
import { describe, expect, it } from 'vitest';
import { withCsrfHeader } from './csrf.interceptor';

describe('withCsrfHeader', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)('adds X-CSRF-Token on %s', (method) => {
    const request = new HttpRequest(method, '/api/x', {});
    expect(withCsrfHeader(request, 'tok').headers.get('X-CSRF-Token')).toBe('tok');
  });

  it('leaves GET requests untouched', () => {
    const request = new HttpRequest('GET', '/api/x');
    expect(withCsrfHeader(request, 'tok').headers.has('X-CSRF-Token')).toBe(false);
  });

  it('sends nothing when there is no session token', () => {
    const request = new HttpRequest('POST', '/api/auth/login', {});
    expect(withCsrfHeader(request, null).headers.has('X-CSRF-Token')).toBe(false);
  });
});
