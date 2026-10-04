import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

/** Everything except /login needs a session; without one the user lands on the login page. */
export const authGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  await auth.ensureLoaded();
  return auth.session() ? true : inject(Router).createUrlTree(['/login']);
};

export const guestGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  await auth.ensureLoaded();
  return auth.session() ? inject(Router).createUrlTree(['/']) : true;
};
