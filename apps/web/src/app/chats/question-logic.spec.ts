import type { AskedQuestion } from '@agents-panel/shared';
import { describe, expect, it } from 'vitest';
import {
  buildAnswerBody,
  emptyDraft,
  formatAnswer,
  incompleteReason,
  isComplete,
  setText,
  toggleOption,
} from './question-logic';

const COLOR: AskedQuestion = {
  question: '¿Cuál es tu color favorito?',
  header: 'Color',
  options: [
    { label: 'Rojo', description: '' },
    { label: 'Azul', description: '' },
  ],
  multiSelect: false,
};
const EXTRAS: AskedQuestion = {
  question: '¿Qué agregamos?',
  header: 'Extras',
  options: [
    { label: 'Tests', description: '' },
    { label: 'Docs', description: '' },
  ],
  multiSelect: true,
};

describe('toggleOption', () => {
  it('keeps one answer on a single-choice question and clears the text', () => {
    const picked = toggleOption(COLOR, { selected: ['Rojo'], text: '' }, 'Azul');
    expect(picked).toEqual({ selected: ['Azul'], text: '' });
    expect(toggleOption(COLOR, { selected: [], text: 'Verde' }, 'Rojo')).toEqual({
      selected: ['Rojo'],
      text: '',
    });
  });

  it('unpicks the chosen option when it is picked again', () => {
    expect(toggleOption(COLOR, { selected: ['Rojo'], text: '' }, 'Rojo').selected).toEqual([]);
  });

  it('adds and removes options on a multi-select question, keeping the text', () => {
    const one = toggleOption(EXTRAS, { selected: [], text: 'CI' }, 'Tests');
    const two = toggleOption(EXTRAS, one, 'Docs');
    expect(two).toEqual({ selected: ['Tests', 'Docs'], text: 'CI' });
    expect(toggleOption(EXTRAS, two, 'Tests').selected).toEqual(['Docs']);
  });
});

describe('setText', () => {
  it('replaces the option on a single-choice question once there is text', () => {
    expect(setText(COLOR, { selected: ['Rojo'], text: '' }, 'Verde')).toEqual({
      selected: [],
      text: 'Verde',
    });
    expect(setText(COLOR, { selected: ['Rojo'], text: 'x' }, '  ')).toEqual({
      selected: ['Rojo'],
      text: '  ',
    });
  });

  it('keeps the options on a multi-select question', () => {
    expect(setText(EXTRAS, { selected: ['Docs'], text: '' }, 'CI')).toEqual({
      selected: ['Docs'],
      text: 'CI',
    });
  });
});

describe('isComplete / incompleteReason', () => {
  const questions = [COLOR, EXTRAS];

  it('needs an option or some text for every question, and says what is missing', () => {
    const empty = emptyDraft(questions);
    expect(isComplete(questions, empty)).toBe(false);
    expect(incompleteReason(questions, empty)).toBe(
      'Elegí una opción o escribí una respuesta en: Color, Extras.',
    );
    const half = { ...empty, [COLOR.question]: { selected: ['Rojo'], text: '' } };
    expect(incompleteReason(questions, half)).toContain('Extras');
    expect(incompleteReason(questions, half)).not.toContain('Color');
    const full = { ...half, [EXTRAS.question]: { selected: [], text: 'solo CI' } };
    expect(isComplete(questions, full)).toBe(true);
    expect(incompleteReason(questions, full)).toBeNull();
  });

  it('does not count blank text as an answer', () => {
    expect(isComplete([COLOR], { [COLOR.question]: { selected: [], text: '   ' } })).toBe(false);
  });
});

describe('buildAnswerBody', () => {
  it('builds the POST body: chosen labels, trimmed text, null when empty', () => {
    expect(
      buildAnswerBody([COLOR, EXTRAS], {
        [COLOR.question]: { selected: ['Azul'], text: '' },
        [EXTRAS.question]: { selected: ['Tests', 'Docs'], text: '  CI  ' },
      }),
    ).toEqual({
      answer: {
        [COLOR.question]: { selected: ['Azul'], text: null },
        [EXTRAS.question]: { selected: ['Tests', 'Docs'], text: 'CI' },
      },
    });
  });

  it('sends an empty entry for a question without a draft instead of dropping it', () => {
    expect(buildAnswerBody([COLOR], {})).toEqual({
      answer: { [COLOR.question]: { selected: [], text: null } },
    });
  });
});

describe('formatAnswer', () => {
  it('joins options and free text for the history', () => {
    expect(formatAnswer({ selected: ['Tests', 'Docs'], text: 'CI' })).toBe('Tests, Docs, CI');
    expect(formatAnswer({ selected: [], text: 'Verde' })).toBe('Verde');
    expect(formatAnswer({ selected: ['Rojo'], text: null })).toBe('Rojo');
  });
});
