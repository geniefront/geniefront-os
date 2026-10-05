import os, subprocess, sys
root='/Users/naiyouzhu/siteadmin/geniefront-os'
env={k:os.environ[k] for k in ['PATH','HOME','TMPDIR'] if k in os.environ}
env.update({'LOG_LEVEL':'silent','NODE_ENV':'test','GF_TEST_NO_DOTENV':'1','DATABASE_TEST_TARGET':'isolated','SEED_SKIP_AUTH':'1','DATABASE_URL':'postgresql://app_user:audit_app_only@127.0.0.1:57208/audit_pristine_restored','MIGRATION_DATABASE_URL':'postgresql://postgres:audit_local_only@127.0.0.1:57208/audit_pristine_restored','APP_DB_PASSWORD':'audit_app_only','SUPABASE_URL':'http://127.0.0.1:59999','SUPABASE_ANON_KEY':'audit-placeholder','APP_JWT_SECRET':'audit-isolated-local-placeholder-0000000000','FORM_ENCRYPTION_KEY':'000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f','TELNYX_API_KEY':'audit-placeholder','TELNYX_SMS_FROM':'+18005550199'})
env['TEST_DATABASE_URL']=env['DATABASE_URL'];env['TEST_MIGRATION_DATABASE_URL']=env['MIGRATION_DATABASE_URL'];env['TEST_APP_DB_PASSWORD']=env['APP_DB_PASSWORD']

if len(sys.argv)<2: raise SystemExit('Explicit command required')
sys.exit(subprocess.call(sys.argv[1:],cwd=root,env=env))
