import type postgres from 'postgres';
import type { CommandContext } from '@gf/contracts';

export interface HardwareDeviceView {
  deviceId: string;
  label: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  state: 'online' | 'offline' | 'revoked';
  terminalType: 'customer-facing' | 'kiosk' | null;
  model: string | null;
  ipAddress: string | null;
  batteryLevel: number | null;
  wifiSignalDbm: number | null;
  appVersion: string | null;
  pendingCommandCount: number;
}

export async function loadHardwareDevices(tx: postgres.TransactionSql, ctx: CommandContext): Promise<{ devices: HardwareDeviceView[] }> {
  const rows = await tx<{
    id: string; label: string; last_seen_at: Date | string | null;
    revoked_at: Date | string | null; created_at: Date | string;
    terminal_type: 'customer-facing' | 'kiosk' | null; model: string | null;
    ip_address: string | null; battery_level: number | null;
    wifi_signal_dbm: number | null; app_version: string | null;
    pending_command_count: string | number;
  }[]>`
    select d.id, d.label, d.last_seen_at, d.revoked_at, d.created_at,
           d.terminal_type, d.model, host(d.ip_address) as ip_address,
           d.battery_level, d.wifi_signal_dbm, d.app_version,
           count(c.id) filter (where c.status = 'pending') as pending_command_count
    from device_tokens d
    left join device_commands c on c.device_id = d.id
    where d.location_id = ${ctx.locationId}
    group by d.id
    order by d.revoked_at nulls first, d.created_at desc`;
  const onlineCutoff = Date.now() - 5 * 60_000;
  return {
    devices: rows.map((row) => {
      const lastSeenAt = row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null;
      return {
        deviceId: row.id,
        label: row.label,
        lastSeenAt,
        revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
        createdAt: new Date(row.created_at).toISOString(),
        state: row.revoked_at ? 'revoked' : lastSeenAt && new Date(lastSeenAt).getTime() >= onlineCutoff ? 'online' : 'offline',
        terminalType: row.terminal_type,
        model: row.model,
        ipAddress: row.ip_address,
        batteryLevel: row.battery_level,
        wifiSignalDbm: row.wifi_signal_dbm,
        appVersion: row.app_version,
        pendingCommandCount: Number(row.pending_command_count),
      };
    }),
  };
}
