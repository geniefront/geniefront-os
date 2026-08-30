import type { PortalType } from '@/lib/session';

/**
 * A pure technician, or a dual-role user who explicitly chose the technician
 * portal, must never mount the administrative route tree. The API remains the
 * security boundary; this closes the matching navigation/UX boundary.
 */
export function isTechWorkspaceOnly(input: {
  activePortal: PortalType;
  isPureTech: boolean;
  isTechCapable: boolean;
}): boolean {
  return input.isPureTech || (input.activePortal === 'tech' && input.isTechCapable);
}
