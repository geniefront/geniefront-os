/**
 * Evidence for sql/0119 (U01 / S3–S6, 验收 T01)：新建门店的
 * `settings.features` 显式默认值触发器。
 *
 *   · 新插入的门店：`health_forms_enabled` / `ai_voice_requested` 均补 false，
 *     其他 settings 字段（capacity 等）不动。
 *   · 显式传入的 features 值优先（`|| existing_features`）——「关」和「开」都
 *     按传入值落库，触发器不覆盖。
 *   · **只影响新插入**：既有门店缺字段不被回填（BEFORE INSERT，不碰旧行）。
 *   · `create or replace function` + `drop trigger if exists` → 重复应用干净。
 *
 * 全程在一个回滚事务里做，不向隔离库留任何门店行。
 * ⚠️ 需要隔离库（`DATABASE_TEST_TARGET=isolated` + `TEST_*` 连接串）。
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { adminSql } from './admin';
import { closeDb } from './client';

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '../sql');
const M119 = '0119_health_form_feature_defaults.sql';

afterAll(async () => {
  await closeDb();
});

type Row = { settings: Record<string, unknown> };

/**
 * 用 SQL 表达式（非绑定参数）构造 `settings`，避开 postgres.js 对
 * JS 字符串参数 → jsonb 的边角行为，让 `new.settings` 稳定是 jsonb 对象。
 * ⚠️ 全部走事务句柄 `sql`：admin 连接池很窄，`begin` 内再用模块级 `adminSql`
 * 会等一个永远拿不到的空闲连接。
 */
async function insertLocation(
  sql: postgres.TransactionSql,
  slug: string,
  settingsSql: string,
): Promise<Row> {
  const publicKey = `pk_${slug.replace(/[^a-z0-9]/g, '')}`;
  const [row] = await sql.unsafe<Row[]>(
    `insert into locations (org_id, name, slug, timezone, business_type, public_key, settings)
     values ('${NAIL_ORG}', jsonb_build_object('en', '${slug}'), '${slug}',
             'America/New_York', 'nail', '${publicKey}', ${settingsSql})
     returning settings`,
  );
  return row!;
}

describe('0119 门店功能默认值触发器', () => {
  it('新店补 false、显式值优先、不回填旧店、可重复应用', async () => {
    // 触发器函数体幂等：先重放一次证明 create-or-replace / drop-if-exists 干净。
    const body = await readFile(join(SQL_DIR, M119), 'utf8');
    await adminSql.unsafe(body);

    await expect(adminSql.begin(async (sql) => {
      // 1. 完全没传 features → 两项补 false，capacity 原样保留。
      const fresh = await insertLocation(
        sql, 't01-fresh',
        `jsonb_build_object('capacity', jsonb_build_object('slot_minutes', 15))`,
      );
      expect(fresh.settings['features']).toEqual({
        health_forms_enabled: false,
        ai_voice_requested: false,
      });
      expect(fresh.settings['capacity']).toEqual({ slot_minutes: 15 });

      // 2. 显式「关」——保持关，不因触发器变化。
      const explicitOff = await insertLocation(
        sql, 't01-off',
        `jsonb_build_object('features', jsonb_build_object(
           'health_forms_enabled', false, 'ai_voice_requested', false))`,
      );
      expect(explicitOff.settings['features']).toEqual({
        health_forms_enabled: false,
        ai_voice_requested: false,
      });

      // 3. 显式「开」健康表 → 保留 true，另一项补 false。
      const explicitOn = await insertLocation(
        sql, 't01-on',
        `jsonb_build_object('features', jsonb_build_object('health_forms_enabled', true))`,
      );
      expect(explicitOn.settings['features']).toEqual({
        health_forms_enabled: true,
        ai_voice_requested: false,
      });

      // 4. 不回填旧店：抹掉 features 后再 update（非 insert），触发器不介入。
      await sql`update locations set settings = settings - 'features' where slug = 't01-on'`;
      const [afterUpdate] = await sql<Row[]>`
        select settings from locations where slug = 't01-on'`;
      expect(afterUpdate!.settings['features']).toBeUndefined();

      // 收尾：抛错回滚，隔离库不留任何 t01-* 门店。
      throw new Error('__rollback__');
    })).rejects.toThrow('__rollback__');

    const [count] = await adminSql<{ n: number }[]>`
      select count(*)::int as n from locations where slug like 't01-%'`;
    expect(count?.n ?? -1).toBe(0);
  });
});
