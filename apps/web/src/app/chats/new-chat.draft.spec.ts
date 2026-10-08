import { describe, expect, it } from 'vitest';
import { NewChatDraft } from './new-chat.draft';

describe('NewChatDraft', () => {
  it('keeps what was typed for the same project', () => {
    const draft = new NewChatDraft();
    draft.use(1);
    draft.slug.set('arreglar-login');
    draft.prompt.set('Arreglá el login');
    draft.use(1);
    expect(draft.slug()).toBe('arreglar-login');
    expect(draft.prompt()).toBe('Arreglá el login');
  });

  it('drops the draft of another project and on reset', () => {
    const draft = new NewChatDraft();
    draft.use(1);
    draft.slug.set('a');
    draft.kind.set('direct');
    draft.use(2);
    expect(draft.slug()).toBe('');
    expect(draft.kind()).toBe('work');
    draft.slug.set('b');
    draft.reset();
    expect(draft.slug()).toBe('');
  });
});
