import type { Chat } from '@agents-panel/shared';

export const RUNTIME_APPROX_HELP =
  'Aproximado: este chat es anterior a la medición y solo cuenta las sesiones de IA, sin los pasos del panel.';

/** «45 s», «12 min» or «1 h 12 min» (seconds under a minute, minutes under an hour). */
export function formatRuntime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${String(totalSeconds)} s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${String(totalMinutes)} min`;
  const hours = String(Math.floor(totalMinutes / 60));
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours} h` : `${hours} h ${String(minutes)} min`;
}

/** Runtime text of a chat card; an approximate one gets the «≈» prefix. */
export function runtimeLabel(chat: Pick<Chat, 'runtimeMs' | 'runtimeApprox'>): string {
  const text = formatRuntime(chat.runtimeMs);
  return chat.runtimeApprox ? `≈ ${text}` : text;
}

/** Short local creation date (e.g. «6/10/2026»). */
export function createdLabel(createdAt: number): string {
  return new Date(createdAt).toLocaleDateString('es-AR', {
    day: 'numeric',
    month: 'numeric',
    year: '2-digit',
  });
}
