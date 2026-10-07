import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import type { DiskRefreshResponse, DiskUsage, MemoryUsage } from '@agents-panel/shared';
import { firstValueFrom } from 'rxjs';
import { diskState, memoryState } from './capacity-logic';

/** Disk and RAM views of the Proyectos page. The CSRF header comes from the HTTP interceptor. */
@Injectable({ providedIn: 'root' })
export class CapacityService {
  private readonly http = inject(HttpClient);

  readonly disk = signal<DiskUsage | null>(null);
  readonly memory = signal<MemoryUsage | null>(null);
  private readonly diskFailed = signal(false);
  private readonly memoryFailed = signal(false);
  /** True from the click on Recalcular until the API reports it is measuring. */
  readonly refreshing = signal(false);

  readonly diskState = computed(() => diskState(this.disk(), this.diskFailed()));
  readonly memoryState = computed(() => memoryState(this.memory(), this.memoryFailed()));
  readonly measuringDisk = computed(
    () => this.refreshing() || this.disk()?.measuring === true || this.diskState() === 'measuring',
  );

  async load(): Promise<void> {
    await Promise.all([this.loadDisk(), this.loadMemory()]);
  }

  async loadDisk(): Promise<void> {
    try {
      this.disk.set(await firstValueFrom(this.http.get<DiskUsage>('/api/capacity/disk')));
      this.diskFailed.set(false);
    } catch {
      // Keep the last good numbers if there are any; the state only turns to error without them.
      this.diskFailed.set(true);
    }
  }

  async loadMemory(): Promise<void> {
    try {
      this.memory.set(await firstValueFrom(this.http.get<MemoryUsage>('/api/capacity/memory')));
      this.memoryFailed.set(false);
    } catch {
      this.memoryFailed.set(true);
    }
  }

  /** Asks the API to measure again, then reads the state (which says it is measuring). */
  async refresh(): Promise<void> {
    this.refreshing.set(true);
    try {
      await firstValueFrom(this.http.post<DiskRefreshResponse>('/api/capacity/disk/refresh', {}));
    } catch {
      this.diskFailed.set(true);
    }
    try {
      await this.loadDisk();
    } finally {
      this.refreshing.set(false);
    }
  }
}
