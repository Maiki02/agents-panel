import { Injectable, signal } from '@angular/core';

/**
 * Name of the project open under /projects/:id, for the header title. The project layout sets it
 * when the project loads and clears it when it is destroyed.
 */
@Injectable({ providedIn: 'root' })
export class PageTitleStore {
  readonly projectName = signal<string | null>(null);
}
