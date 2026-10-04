import { HttpErrorResponse } from '@angular/common/http';
import { describe, expect, it } from 'vitest';
import { apiErrorMessage } from '../chats/chats.service';

const failure = (status: number, error: unknown) => new HttpErrorResponse({ status, error });

describe('apiErrorMessage', () => {
  it('translates invalid_totp instead of showing the code', () => {
    expect(apiErrorMessage(failure(401, { error: 'invalid_totp' }))).toBe(
      'Código incorrecto o ya usado. Esperá el próximo código de la app.',
    );
  });

  it('keeps the server message, the 429 text and the generic fallbacks', () => {
    expect(apiErrorMessage(failure(409, { error: 'Ya existe' }))).toBe('Ya existe');
    expect(apiErrorMessage(failure(429, null))).toBe(
      'Demasiados intentos, probá de nuevo en un minuto.',
    );
    expect(apiErrorMessage(failure(500, null))).toBe('Error 500');
    expect(apiErrorMessage(new Error('x'))).toBe('Error inesperado.');
  });
});
