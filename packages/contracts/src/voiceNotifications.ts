/** Explicit null disables a channel; absent settings retain existing delivery targets. */
export function voiceNotificationTargets(settings: unknown, fallback: { email: string | null; phone: string | null }) {
  const root = settings && typeof settings === 'object' ? settings as Record<string, unknown> : {};
  const raw = root.voice_notifications;
  const config = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return {
    email: 'email' in config ? typeof config.email === 'string' && config.email ? config.email : null : fallback.email,
    phone: 'phone' in config ? typeof config.phone === 'string' && config.phone ? config.phone : null : fallback.phone,
  };
}
