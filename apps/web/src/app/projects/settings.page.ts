import { ChangeDetectionStrategy, Component, computed, effect, inject, input } from '@angular/core';
import { Router } from '@angular/router';
import { Tabs } from '../ui/tabs';
import { resolveTab } from '../ui/tabs-logic';
import { EnvFilesSection } from './env-files.section';
import { ModelsSection } from './models.section';
import { PermissionsSection } from './permissions.section';
import { ProjectsService } from './projects.service';
import { ProjectContext } from './project-context';
import { ProjectDangerZone } from './project-danger-zone';
import { ProjectGeneralSettings } from './project-settings';
import { RepoActionsSection } from './repo-actions.section';
import { SETTINGS_TABS, settingsTabPath } from './settings-tabs';

/** settings/:tab: one tab at a time; the active tab lives in the URL. */
@Component({
  selector: 'app-settings-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    Tabs,
    ProjectGeneralSettings,
    ProjectDangerZone,
    EnvFilesSection,
    RepoActionsSection,
    PermissionsSection,
    ModelsSection,
  ],
  template: `
    @if (context.project(); as p) {
      <section class="card">
        <h2>Configuración</h2>
        <app-tabs [tabs]="tabs" [active]="current()" (selected)="select(p.id, $event)" />
        <div class="pt-4">
          @switch (current()) {
            @case ('general') {
              <app-project-general [project]="p" (changed)="context.project.set($event)" />
              <app-project-danger-zone [project]="p" />
            }
            @case ('environment') {
              <app-env-files-section [projectId]="p.id" />
            }
            @case ('repository') {
              <app-repo-actions [project]="p" (refresh)="reload(p.id)" />
            }
            @case ('permissions') {
              <app-permissions-section [projectId]="p.id" />
            }
            @case ('models') {
              <app-models-section [projectId]="p.id" />
            }
          }
        </div>
      </section>
    }
  `,
})
export class SettingsPage {
  protected readonly context = inject(ProjectContext);
  private readonly router = inject(Router);
  private readonly projects = inject(ProjectsService);

  /** Route param `:tab` (bound by withComponentInputBinding). */
  readonly tab = input<string>();

  protected readonly tabs = SETTINGS_TABS;
  private readonly ids = SETTINGS_TABS.map((t) => t.id);
  protected readonly current = computed(() => resolveTab(this.ids, this.tab()));

  constructor() {
    // An unknown tab in the URL is replaced by the first one instead of showing a blank page.
    effect(() => {
      const project = this.context.project();
      const requested = this.tab();
      if (project && requested !== undefined && !this.ids.includes(requested)) {
        void this.router.navigateByUrl(settingsTabPath(project.id, this.current()), {
          replaceUrl: true,
        });
      }
    });
  }

  /** Reads the project again: a pull or a merged init branch may have brought Kyro. */
  protected async reload(projectId: number): Promise<void> {
    try {
      this.context.project.set(await this.projects.get(projectId));
    } catch {
      // The screen keeps what it had; the next reload tries again.
    }
  }

  protected select(projectId: number, tab: string): void {
    void this.router.navigateByUrl(settingsTabPath(projectId, tab));
  }
}
