import { describe, expect, it } from 'vitest';
import { DEFAULT_MODELS, MODEL_CATALOG } from '@agents-panel/shared';
import {
  MAX_COMMAND_LENGTH,
  PANEL_DEFAULT,
  choiceOf,
  failedField,
  modelChoices,
  modelsChanged,
  selectionFrom,
  validateCommandValue,
} from './settings-logic';

const saved = {
  provider: 'claude',
  thinker: 'claude-fable-5-1',
  executor: DEFAULT_MODELS.executor,
} as const;

describe('model choices', () => {
  it('puts the panel default first and then the whole catalog', () => {
    const options = modelChoices('claude', 'thinker');
    expect(options[0]).toEqual({
      value: PANEL_DEFAULT,
      label: `Por defecto del panel (${DEFAULT_MODELS.thinker})`,
    });
    expect(options.slice(1).map((o) => o.value)).toEqual([...MODEL_CATALOG.claude]);
  });

  it('shows the default when the saved model is the panel one', () => {
    expect(choiceOf('thinker', DEFAULT_MODELS.thinker)).toBe(PANEL_DEFAULT);
    expect(choiceOf('thinker', 'claude-fable-5-1')).toBe('claude-fable-5-1');
  });

  it('saves the panel default as that model, and a chosen one as it is', () => {
    expect(
      selectionFrom('claude', { thinker: PANEL_DEFAULT, executor: 'claude-haiku-4-5-20251001' }),
    ).toEqual({
      provider: 'claude',
      thinker: DEFAULT_MODELS.thinker,
      executor: 'claude-haiku-4-5-20251001',
    });
  });

  it('detects whether the draft differs from what is saved', () => {
    expect(modelsChanged(saved, { thinker: 'claude-fable-5-1', executor: PANEL_DEFAULT })).toBe(
      false,
    );
    expect(modelsChanged(saved, { thinker: PANEL_DEFAULT, executor: PANEL_DEFAULT })).toBe(true);
  });
});

describe('validate command', () => {
  it('trims, clears an empty one with null and refuses a long one', () => {
    expect(validateCommandValue('  npm test ')).toEqual({ value: 'npm test', problem: null });
    expect(validateCommandValue('   ')).toEqual({ value: null, problem: null });
    expect(validateCommandValue('x'.repeat(MAX_COMMAND_LENGTH)).problem).toBeNull();
    expect(validateCommandValue('x'.repeat(MAX_COMMAND_LENGTH + 1)).problem).toMatch(/Máximo/);
  });

  it('attributes a failed save to the field that changed', () => {
    const base = { setupCommand: 'npm ci', validateCommand: null };
    expect(failedField(base, { ...base, validateCommand: 'npm test' })).toBe('validate');
    expect(failedField(base, { ...base, setupCommand: null })).toBe('setup');
    expect(failedField(base, { setupCommand: null, validateCommand: 'x' })).toBe('form');
    expect(failedField(base, base)).toBe('form');
  });
});
