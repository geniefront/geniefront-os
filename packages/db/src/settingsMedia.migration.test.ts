import { afterAll, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { adminSql } from './admin';
const user = '196f0ab4-cd94-45cc-8109-2c414e966828';
const other = '33333333-3333-4333-8333-333333333333';
const path = `${user}/settings-upload-test.webp`;
afterAll(async () => {
 await adminSql`delete from storage.objects where name=${path}`;
 await adminSql.end();
});
it('reapplies the migration and provisions raster-only public buckets', async () => {
 await adminSql.unsafe(await readFile(new URL('../sql/20260921171225_settings_media_owner_transfer.sql', import.meta.url), 'utf8'));
 const rows = await adminSql`select id,public,allowed_mime_types from storage.buckets where id in ('store_logos','avatars')`;
 expect(rows).toHaveLength(2);
 expect(rows.every(r => r.public && !r.allowed_mime_types.includes('image/svg+xml'))).toBe(true);
});
it('permits an authenticated user to insert only into their own image folder', async () => {
 await adminSql.begin(async tx => {
   await tx`set local role authenticated`;
   await tx`select set_config('request.jwt.claim.sub',${user},true)`;
   await tx`insert into storage.objects(bucket_id,name) values('store_logos',${path})`;
 });
 await expect(adminSql.begin(async tx => {
   await tx`set local role authenticated`;
   await tx`select set_config('request.jwt.claim.sub',${other},true)`;
   await tx`insert into storage.objects(bucket_id,name) values('store_logos',${path})`;
 })).rejects.toMatchObject({ code: '42501' });
 await expect(adminSql.begin(async tx => {
   await tx`set local role authenticated`;
   await tx`select set_config('request.jwt.claim.sub',${user},true)`;
   await tx`insert into storage.objects(bucket_id,name) values('store_logos',${user + '/bad.svg'})`;
 })).rejects.toMatchObject({ code: '42501' });
});
it('keeps ownership transfer functions and state inaccessible to direct customer roles', async () => {
 const [access] = await adminSql`select has_function_privilege('authenticated','gf_private.complete_owner_transfer(uuid)','EXECUTE') as execute, has_table_privilege('app_user','gf_private.owner_transfers','UPDATE') as mutate`;
 expect(access).toMatchObject({ execute: false, mutate: false });
});
