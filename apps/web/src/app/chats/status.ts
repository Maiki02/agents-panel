import type { ChatStatus } from '@agents-panel/shared';

const LABELS: Record<ChatStatus, string> = {
  running: 'En curso',
  idle: 'En espera',
  error: 'Error',
  interrupted: 'Interrumpido',
  cancelled: 'Cancelado',
};

export function statusLabel(status: ChatStatus): string {
  return LABELS[status];
}
