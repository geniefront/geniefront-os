-- 0054: 个人资料与通知中心增强 (Profile & In-App Notification Center)

-- 1. 扩展 users 与 staff_profiles 字段
ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'America/New_York';

ALTER TABLE staff_profiles ADD COLUMN IF NOT EXISTS nickname TEXT;
ALTER TABLE staff_profiles ADD COLUMN IF NOT EXISTS skills TEXT[] NOT NULL DEFAULT '{}';

-- 2. 用户设备登录会话表 (user_device_sessions)
CREATE TABLE IF NOT EXISTS user_device_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_label TEXT NOT NULL,
    browser TEXT,
    os TEXT,
    ip_address TEXT,
    refresh_token_hash TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    last_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS user_device_sessions_user_idx ON user_device_sessions(user_id, is_active);

ALTER TABLE user_device_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_device_sessions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_device_sessions_isolation ON user_device_sessions;
CREATE POLICY user_device_sessions_isolation ON user_device_sessions
    USING (user_id = auth.uid() OR user_id = app_user_id())
    WITH CHECK (user_id = auth.uid() OR user_id = app_user_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON user_device_sessions TO app_user;

-- 3. 个人通知偏好表 (user_notification_preferences)
CREATE TABLE IF NOT EXISTS user_notification_preferences (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    location_id UUID REFERENCES locations(id) ON DELETE CASCADE,
    in_app JSONB NOT NULL DEFAULT '{"appointmentNew": true, "appointmentChanged": true, "appointmentCancelled": true, "paymentFailed": true, "customerFeedback": true, "payoutSettled": true, "systemSecurity": true}'::jsonb,
    sms JSONB NOT NULL DEFAULT '{"appointmentNew": true, "appointmentChanged": false, "emergencyAlerts": true}'::jsonb,
    email JSONB NOT NULL DEFAULT '{"dailyDigest": true, "financialReports": true, "securityAlerts": true}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(user_id)
);

ALTER TABLE user_notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_notification_preferences FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_notif_prefs_isolation ON user_notification_preferences;
CREATE POLICY user_notif_prefs_isolation ON user_notification_preferences
    USING (user_id = auth.uid() OR user_id = app_user_id())
    WITH CHECK (user_id = auth.uid() OR user_id = app_user_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON user_notification_preferences TO app_user;

-- 4. 应用内通知表 (in_app_notifications)
CREATE TABLE IF NOT EXISTS in_app_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    recipient_user_id UUID REFERENCES users(id) ON DELETE CASCADE, -- NULL 表示全店广播
    category TEXT NOT NULL CHECK (category IN ('bookings', 'operations', 'customers', 'system')),
    level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warning', 'error', 'success')),
    title TEXT NOT NULL,
    title_key TEXT,
    message TEXT NOT NULL,
    read BOOLEAN NOT NULL DEFAULT false,
    read_at TIMESTAMPTZ,
    action_type TEXT CHECK (action_type IN ('appointment', 'ticket', 'queue', 'customer', 'settings')),
    action_target_id TEXT,
    action_url TEXT,
    meta JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS in_app_notif_loc_read_idx ON in_app_notifications(location_id, recipient_user_id, read);
CREATE INDEX IF NOT EXISTS in_app_notif_created_idx ON in_app_notifications(created_at DESC);

ALTER TABLE in_app_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE in_app_notifications FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON in_app_notifications;
CREATE POLICY tenant_isolation ON in_app_notifications
    USING (
        location_id = app_location_id()
        AND (recipient_user_id IS NULL OR recipient_user_id = app_user_id())
    )
    WITH CHECK (
        location_id = app_location_id()
        AND (recipient_user_id IS NULL OR recipient_user_id = app_user_id())
    );

GRANT SELECT, INSERT, UPDATE, DELETE ON in_app_notifications TO app_user;
