import type { HttpInterceptorFn, HttpRequest } from '@angular/common/http';
import { inject } from '@angular/core';
import { AuthService } from './auth.service';

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Pure so it can be unit tested: adds the CSRF header to state-changing requests. */
export function withCsrfHeader(
  request: HttpRequest<unknown>,
  token: string | null,
): HttpRequest<unknown> {
  if (token === null || !STATE_CHANGING.has(request.method)) return request;
  return request.clone({ setHeaders: { 'X-CSRF-Token': token } });
}

export const csrfInterceptor: HttpInterceptorFn = (request, next) =>
  next(withCsrfHeader(request, inject(AuthService).csrfToken()));
