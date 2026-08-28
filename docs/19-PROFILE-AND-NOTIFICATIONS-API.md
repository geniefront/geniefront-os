# 19 · 个人资料与通知中心后端 API 增改需求规范

> **面向后端开发团队**：本文档详细定义了「个人资料 (Personal Profile)」与「通知中心 (Notification Center)」前端所需的所有后端 REST 读接口、命令总线写接口 (Command Bus)、数据库表结构设计及权限映射。

---

## 目录

1. [模块一：个人资料与账号管理 (Profile & Identity)](#1-模块一个人资料与账号管理-profile--identity)
   - 1.1 `GET /v1/me/profile`（获取当前用户详细资料）
   - 1.2 `POST /v1/commands/user.updateProfile`（更新用户个人档案）
   - 1.3 `POST /v1/commands/staff.setPin`（设置/重置 POS 快速解锁 PIN 码）
   - 1.4 `GET /v1/me/sessions`（获取活跃登录设备与会话列表）
   - 1.5 `POST /v1/commands/user.revokeSession`（踢下线指定设备会话）
   - 1.6 `GET /v1/me/notification-preferences`（获取个人通知偏好）
   - 1.7 `POST /v1/commands/user.saveNotificationPreferences`（保存个人通知偏好）
2. [模块二：通知中心 (Notification Center)](#2-模块二通知中心-notification-center)
   - 2.1 `GET /v1/desk/notifications`（获取通知中心列表及过滤）
   - 2.2 `GET /v1/desk/notifications/stats`（获取各分类未读统计计数）
   - 2.3 `POST /v1/commands/notification.markRead`（标记单条通知为已读）
   - 2.4 `POST /v1/commands/notification.markAllRead`（一键全部已读 / 按分类已读）
   - 2.5 `POST /v1/commands/notification.delete`（删除单条通知）
   - 2.6 `POST /v1/commands/notification.clearRead`（一键清理已读通知）
3. [数据库表结构与变更 (Database Migrations)](#3-数据库表结构与变更-database-migrations)
   - 3.1 `in_app_notifications`（应用内通知表）
   - 3.2 `user_notification_preferences`（个人通知偏好表）
   - 3.3 `user_device_sessions`（用户设备登录会话表）
4. [错误码对照表](#4-错误码对照表)

---

## 1. 模块一：个人资料与账号管理 (Profile & Identity)

### 1.1 获取当前用户详细资料
- **Method**: `GET`
- **Path**: `/v1/me/profile`
- **Headers**:
  - `Authorization: Bearer <jwt>`
  - `X-Membership-Id: <membershipId>` (可选)
- **Response 200**:
```json
{
  "userId": "usr_9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "email": "owner@lotusspanyc.com",
  "fullName": "Emily Watson",
  "nickname": "Lisa",
  "phone": "+1 (555) 019-2834",
  "avatarUrl": "",
  "locale": "zh",
  "timezone": "America/New_York",
  "bio": "前台运营及门店管理负责人 · 专注于极致客户体验与高效店务调度",
  "createdAt": "2026-01-15T08:00:00.000Z",
  "staffInfo": {
    "membershipId": "mem_a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "employeeNo": "EMP-001",
    "jobTitle": "门店负责人 / 总监",
    "levelName": "资深主管",
    "skills": ["日式光疗美甲", "手足精油SPA", "前台店务调度", "VIP客户服务"],
    "isBookable": true,
    "maxConcurrentAppointments": 2,
    "inRotation": true,
    "hasPin": true
  }
}
```

### 1.2 更新用户个人档案 (Command)
- **Method**: `POST`
- **Path**: `/v1/commands/user.updateProfile`
- **Headers**:
  - `Authorization: Bearer <jwt>`
  - `X-Membership-Id: <membershipId>`
  - `Idempotency-Key: <uuid>`
- **Request Body**:
```json
{
  "input": {
    "fullName": "Emily Watson",
    "nickname": "Lisa",
    "phone": "+1 (555) 019-2834",
    "bio": "个人简介内容...",
    "locale": "zh",
    "isBookable": true,
    "maxConcurrentAppointments": 2,
    "skills": ["日式光疗美甲", "手足精油SPA", "俄式极致修甲"]
  }
}
```
- **Response 200/201**:
```json
{
  "result": {
    "userId": "usr_9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    "updated": true
  },
  "replayed": false
}
```

### 1.3 设置/重置 POS 快速解锁 PIN 码 (Command)
- **Method**: `POST`
- **Path**: `/v1/commands/staff.setPin`
- **Headers**:
  - `Authorization: Bearer <jwt>`
  - `X-Membership-Id: <membershipId>`
  - `Idempotency-Key: <uuid>`
- **Request Body**:
```json
{
  "input": {
    "pin": "1234"
  }
}
```
- **说明**：后端计算 SHA-256 / bcrypt 哈希后存入 `staff_profiles.pin_hash`，不得在数据库中保存明文。
- **Response 200/201**:
```json
{
  "result": {
    "membershipId": "mem_a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "hasPin": true
  },
  "replayed": false
}
```

### 1.4 获取活跃登录设备与会话列表
- **Method**: `GET`
- **Path**: `/v1/me/sessions`
- **Headers**:
  - `Authorization: Bearer <jwt>`
- **Response 200**:
```json
{
  "sessions": [
    {
      "id": "sess_current",
      "deviceLabel": "Apple MacBook Pro (macOS 15.3)",
      "browser": "Google Chrome 133.0",
      "os": "macOS Sequoia",
      "ipAddress": "172.56.21.90",
      "lastActiveAt": "2026-08-27T17:30:00.000Z",
      "createdAt": "2026-08-27T10:00:00.000Z",
      "isCurrent": true
    },
    {
      "id": "sess_ipad_01",
      "deviceLabel": "iPad Pro 12.9\" (前台主收银终端)",
      "browser": "Safari 18.2 / PWA Standalone",
      "os": "iPadOS 18.2",
      "ipAddress": "192.168.1.102",
      "lastActiveAt": "2026-08-27T16:45:00.000Z",
      "createdAt": "2026-08-20T09:00:00.000Z",
      "isCurrent": false
    }
  ]
}
```

### 1.5 踢下线指定设备会话 (Command)
- **Method**: `POST`
- **Path**: `/v1/commands/user.revokeSession`
- **Headers**:
  - `Authorization: Bearer <jwt>`
  - `Idempotency-Key: <uuid>`
- **Request Body**:
```json
{
  "input": {
    "sessionId": "sess_ipad_01"
  }
}
```
- **Response 200/201**:
```json
{
  "result": {
    "sessionId": "sess_ipad_01",
    "revoked": true
  },
  "replayed": false
}
```

### 1.6 获取个人通知偏好
- **Method**: `GET`
- **Path**: `/v1/me/notification-preferences`
- **Headers**:
  - `Authorization: Bearer <jwt>`
- **Response 200**:
```json
{
  "inApp": {
    "appointmentNew": true,
    "appointmentChanged": true,
    "appointmentCancelled": true,
    "paymentFailed": true,
    "customerFeedback": true,
    "payoutSettled": true,
    "systemSecurity": true
  },
  "sms": {
    "appointmentNew": true,
    "appointmentChanged": false,
    "emergencyAlerts": true
  },
  "email": {
    "dailyDigest": true,
    "financialReports": true,
    "securityAlerts": true
  }
}
```

### 1.7 保存个人通知偏好 (Command)
- **Method**: `POST`
- **Path**: `/v1/commands/user.saveNotificationPreferences`
- **Request Body**:
```json
{
  "input": {
    "inApp": {
      "appointmentNew": true,
      "appointmentChanged": true,
      "appointmentCancelled": true,
      "paymentFailed": true,
      "customerFeedback": true,
      "payoutSettled": true,
      "systemSecurity": true
    },
    "sms": {
      "appointmentNew": true,
      "appointmentChanged": false,
      "emergencyAlerts": true
    },
    "email": {
      "dailyDigest": true,
      "financialReports": true,
      "securityAlerts": true
    }
  }
}
```

---

## 2. 模块二：通知中心 (Notification Center)

### 2.1 获取通知中心列表及过滤
- **Method**: `GET`
- **Path**: `/v1/desk/notifications`
- **Query Parameters**:
  - `category`: `all` | `bookings` | `operations` | `customers` | `system` (可选，默认 `all`)
  - `unreadOnly`: `true` | `false` (可选，默认 `false`)
  - `page`: 整数 (默认 `1`)
  - `pageSize`: 整数 (默认 `30`)
- **Headers**:
  - `Authorization: Bearer <jwt>`
  - `X-Membership-Id: <membershipId>`
- **Response 200**:
```json
{
  "notifications": [
    {
      "id": "notif_01",
      "category": "bookings",
      "level": "info",
      "title": "新的线上预约已提交",
      "message": "顾客 Emily Watson 预约了今日 14:30 的 [日式光疗美甲设计 + 手部SPA]，指定技师 Lisa。",
      "createdAt": "2026-08-27T17:20:00.000Z",
      "read": false,
      "actionType": "appointment",
      "actionTargetId": "apt_uuid_123",
      "actionUrl": "/schedule",
      "meta": {
        "customerName": "Emily Watson",
        "serviceName": "日式光疗美甲设计",
        "staffName": "Lisa (李美华)",
        "appointmentId": "apt_uuid_123"
      }
    },
    {
      "id": "notif_02",
      "category": "operations",
      "level": "warning",
      "title": "Stripe 线上刷卡扣款失败预警",
      "message": "工单 #TK-8902 客户持有的 Visa 尾号 4242 预授权扣款失败 (insufficient_funds)。请前台收银台核对。",
      "createdAt": "2026-08-27T16:30:00.000Z",
      "read": false,
      "actionType": "ticket",
      "actionTargetId": "tk_uuid_456",
      "actionUrl": "/checkout",
      "meta": {
        "ticketId": "TK-8902",
        "amountDollars": 128.50,
        "customerName": "Sophia Taylor"
      }
    }
  ],
  "total": 28,
  "page": 1,
  "pageSize": 30
}
```

### 2.2 获取各分类未读统计计数
- **Method**: `GET`
- **Path**: `/v1/desk/notifications/stats`
- **Headers**:
  - `Authorization: Bearer <jwt>`
  - `X-Membership-Id: <membershipId>`
- **Response 200**:
```json
{
  "total": 45,
  "unread": 3,
  "bookingsUnread": 1,
  "operationsUnread": 1,
  "customersUnread": 1,
  "systemUnread": 0
}
```

### 2.3 标记单条通知为已读 (Command)
- **Method**: `POST`
- **Path**: `/v1/commands/notification.markRead`
- **Request Body**:
```json
{
  "input": {
    "notificationId": "notif_01"
  }
}
```
- **Response 200**:
```json
{
  "result": {
    "notificationId": "notif_01",
    "read": true
  },
  "replayed": false
}
```

### 2.4 一键全部已读 / 按分类已读 (Command)
- **Method**: `POST`
- **Path**: `/v1/commands/notification.markAllRead`
- **Request Body**:
```json
{
  "input": {
    "category": "bookings" 
  }
}
```
*(注：`category` 为可选，不传或传 `"all"` 则清空全部分类未读)*

### 2.5 删除单条通知 (Command)
- **Method**: `POST`
- **Path**: `/v1/commands/notification.delete`
- **Request Body**:
```json
{
  "input": {
    "notificationId": "notif_01"
  }
}
```

### 2.6 一键清理已读通知 (Command)
- **Method**: `POST`
- **Path**: `/v1/commands/notification.clearRead`
- **Request Body**:
```json
{
  "input": {}
}
```

---

## 3. 数据库表结构与变更 (Database Migrations)

### 3.1 应用内通知表 (`in_app_notifications`)
```sql
CREATE TABLE IF NOT EXISTS in_app_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    location_id UUID NOT NULL REFERENCES locations(id),
    recipient_user_id UUID REFERENCES users(id), -- 为空则为全店广播通知
    category TEXT NOT NULL CHECK (category IN ('bookings', 'operations', 'customers', 'system')),
    level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warning', 'error', 'success')),
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    read BOOLEAN NOT NULL DEFAULT false,
    read_at TIMESTAMPTZ,
    action_type TEXT CHECK (action_type IN ('appointment', 'ticket', 'queue', 'customer', 'settings')),
    action_target_id UUID,
    action_url TEXT,
    meta JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS in_app_notif_loc_read_idx ON in_app_notifications(location_id, recipient_user_id, read);
CREATE INDEX IF NOT EXISTS in_app_notif_created_idx ON in_app_notifications(created_at DESC);
```

### 3.2 个人通知偏好表 (`user_notification_preferences`)
```sql
CREATE TABLE IF NOT EXISTS user_notification_preferences (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    location_id UUID REFERENCES locations(id) ON DELETE CASCADE,
    in_app JSONB NOT NULL DEFAULT '{"appointmentNew": true, "appointmentChanged": true, "appointmentCancelled": true, "paymentFailed": true, "customerFeedback": true, "payoutSettled": true, "systemSecurity": true}'::jsonb,
    sms JSONB NOT NULL DEFAULT '{"appointmentNew": true, "appointmentChanged": false, "emergencyAlerts": true}'::jsonb,
    email JSONB NOT NULL DEFAULT '{"dailyDigest": true, "financialReports": true, "securityAlerts": true}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(user_id)
);
```

### 3.3 用户设备登录会话表 (`user_device_sessions`)
```sql
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
```

---

## 4. 错误码对照表

| 错误码 Code | HTTP Status | 触发原因 | 前端推荐处理 |
| :--- | :--- | :--- | :--- |
| `UNAUTHENTICATED` | 401 | JWT 缺失或已过期 | 引导退出登录重新登录 |
| `PERMISSION_DENIED` | 403 | 无权执行此操作 | 提示「权限不足」 |
| `NOTIFICATION_NOT_FOUND` | 404 | 目标通知已删除或不存在 | 刷新通知列表 |
| `INVALID_PIN_FORMAT` | 400 | PIN 码非 4-6 位纯数字 | 表单拦截并提示 |
| `SESSION_ALREADY_REVOKED` | 400 | 目标会话已被踢下线 | 刷新设备列表 |
| `RATE_LIMITED` | 429 | 短信/密码修改请求频次过高 | 提示请稍后再试 |
