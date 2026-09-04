import { describe, expect, it } from 'vitest';
import { aiToolDefinitions, commandCatalogTextForPermissions } from './registry';

describe('copilot command catalog policy', () => {
  it('requires confirmation for every exposed side-effecting command', () => {
    expect(aiToolDefinitions().filter((command) => command.confirm === 'never')).toEqual([]);
  });

  it('filters by caller permission and excludes admin-console commands', () => {
    const catalog = commandCatalogTextForPermissions(new Set([
      'appointment.read', 'appointment.write', 'appointment.cancel',
    ]));
    expect(catalog).toContain('appointment.create');
    expect(catalog).toContain('appointment.cancel');
    expect(catalog).not.toContain('ticket.pay');
    expect(catalog).not.toContain('billing.setAutoTopup');
    expect(catalog).not.toContain('location.saveProfile');
  });
});
