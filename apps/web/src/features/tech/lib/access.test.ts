import { describe, expect, it } from 'vitest';
import { isTechWorkspaceOnly } from './access';

describe('isTechWorkspaceOnly', () => {
  it('keeps a pure technician inside the technician route tree', () => {
    expect(isTechWorkspaceOnly({ activePortal: 'tech', isPureTech: true, isTechCapable: true })).toBe(true);
  });

  it('keeps a dual-role user inside tech routes after choosing the tech portal', () => {
    expect(isTechWorkspaceOnly({ activePortal: 'tech', isPureTech: false, isTechCapable: true })).toBe(true);
  });

  it('allows the administrative tree for the admin portal', () => {
    expect(isTechWorkspaceOnly({ activePortal: 'admin', isPureTech: false, isTechCapable: true })).toBe(false);
  });
});
