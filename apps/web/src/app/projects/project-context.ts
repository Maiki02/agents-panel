import { Injectable, signal } from '@angular/core';
import type { Project } from '@agents-panel/shared';

/** The project of the open /projects/:id layout, shared with its child routes. */
@Injectable()
export class ProjectContext {
  readonly project = signal<Project | null>(null);
}
