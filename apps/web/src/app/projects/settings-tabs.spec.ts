import { describe, expect, it } from 'vitest';
import { resolveTab } from '../ui/tabs-logic';
import { SETTINGS_TABS, settingsTabPath } from './settings-tabs';

describe('settings tabs', () => {
  const ids = SETTINGS_TABS.map((tab) => tab.id);

  it('has General first and unique ids', () => {
    expect(ids[0]).toBe('general');
    expect(ids).toContain('environment');
    expect(ids).toContain('repository');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('builds the URL of a tab and falls back to General for an unknown one', () => {
    expect(settingsTabPath(3, 'environment')).toBe('/projects/3/settings/environment');
    expect(resolveTab(ids, 'nope')).toBe('general');
    expect(resolveTab(ids, 'environment')).toBe('environment');
  });
});
