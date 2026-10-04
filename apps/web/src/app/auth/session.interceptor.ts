import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { AuthService } from './auth.service';

/**
 * True for a 401 that means the session is gone (`unauthorized`). A 401 `invalid_totp` is a wrong
 * or reused code: the session is fine and the form must show the error. Pure for unit tests.
 */
export function isExpiredSession(error: unknown, url: string): boolean {
  if (!(error instanceof HttpErrorResponse) || error.status !== 401) return false;
  if (url.startsWith('/api/auth/')) return false;
  const body = error.error as { error?: unknown } | null;
  return body?.error === 'unauthorized';
}

export const sessionInterceptor: HttpInterceptorFn = (request, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return next(request).pipe(
    catchError((error: unknown) => {
      if (isExpiredSession(error, request.url)) {
        auth.expire();
        void router.navigateByUrl('/login');
      }
      return throwError(() => error);
    }),
  );
};
