import {
  DEFAULT_MODELS,
  MODEL_CATALOG,
  type ModelProvider,
  type ModelRole,
  type ModelSelection,
} from '@agents-panel/shared';

export const MAX_COMMAND_LENGTH = 500;

/** Value of the select for "the panel's default" of a role. */
export const PANEL_DEFAULT = 'default';

export const ROLE_TITLE: Record<ModelRole, string> = {
  thinker: 'Modelo pensante (idea, plan y plan de cada sprint)',
  executor: 'Modelo ejecutor (ejecución, QA, correcciones y cierre)',
};

export interface ModelChoice {
  value: string;
  label: string;
}

/** Options of a role's select: the panel's default first, then the provider's catalog. */
export function modelChoices(provider: ModelProvider, role: ModelRole): ModelChoice[] {
  return [
    { value: PANEL_DEFAULT, label: `Por defecto del panel (${DEFAULT_MODELS[role]})` },
    ...MODEL_CATALOG[provider].map((id) => ({ value: id, label: id })),
  ];
}

/** What the select shows for a saved model: the panel's default when it is that one. */
export function choiceOf(role: ModelRole, model: string): string {
  return model === DEFAULT_MODELS[role] ? PANEL_DEFAULT : model;
}

/** The selection to save: a role left on the panel's default stores that model. */
export function selectionFrom(
  provider: ModelProvider,
  choices: { thinker: string; executor: string },
): ModelSelection {
  const model = (role: ModelRole, choice: string): string =>
    choice === PANEL_DEFAULT ? DEFAULT_MODELS[role] : choice;
  return {
    provider,
    thinker: model('thinker', choices.thinker),
    executor: model('executor', choices.executor),
  };
}

/** Whether the draft differs from what the project has saved. */
export function modelsChanged(
  saved: ModelSelection,
  choices: { thinker: string; executor: string },
): boolean {
  const next = selectionFrom(saved.provider, choices);
  return next.thinker !== saved.thinker || next.executor !== saved.executor;
}

/** What the validation command field sends: empty clears it (null), too long is refused. */
export function validateCommandValue(text: string): {
  value: string | null;
  problem: string | null;
} {
  const value = text.trim();
  if (value.length > MAX_COMMAND_LENGTH) {
    return { value: null, problem: `Máximo ${String(MAX_COMMAND_LENGTH)} caracteres.` };
  }
  return { value: value === '' ? null : value, problem: null };
}

/** Which field of the general form a failed save belongs to, to show the error next to it. */
export function failedField(
  saved: { setupCommand: string | null; validateCommand: string | null },
  draft: { setupCommand: string | null; validateCommand: string | null },
): 'validate' | 'setup' | 'form' {
  const validate = saved.validateCommand !== draft.validateCommand;
  const setup = saved.setupCommand !== draft.setupCommand;
  if (validate && !setup) return 'validate';
  if (setup && !validate) return 'setup';
  return 'form';
}
