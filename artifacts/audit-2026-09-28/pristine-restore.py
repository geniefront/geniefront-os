import subprocess,pathlib,json
p=pathlib.Path(__file__).resolve().parent
scope={};exec((p/'run-isolated.py').read_text().split('if len(sys.argv)<2:')[0],scope)
e=scope['env'];
for key in ['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']:e[key]=e[key].rsplit('/',1)[0]+'/audit_pristine'
steps=[]
def run(args,**kwargs):
 r=subprocess.run(args,env=e,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,**kwargs);steps.append({'command':args,'exitCode':r.returncode,'output':r.stdout.decode()});return r.returncode
# audit_pristine was created by the earlier attempt; bootstrap had not connected.
if run(['psql',e['MIGRATION_DATABASE_URL'],'-v','ON_ERROR_STOP=1','-f','packages/db/test/bootstrap-postgres.sql'])==0:
 if run(['pnpm','db:migrate'])==0 and run(['pnpm','db:seed'])==0:
  with open('/tmp/gf-audit-pristine.dump','wb') as f: subprocess.run(['docker','exec','gf-audit-20260928','pg_dump','-U','postgres','-Fc','audit_pristine'],stdout=f,check=True)
  run(['docker','exec','gf-audit-20260928','createdb','-U','postgres','audit_pristine_restored'])
  with open('/tmp/gf-audit-pristine.dump','rb') as f:run(['docker','exec','-i','gf-audit-20260928','pg_restore','-U','postgres','-d','audit_pristine_restored','--exit-on-error'],stdin=f)
  for db in ['audit_pristine','audit_pristine_restored']:
   run(['docker','exec','gf-audit-20260928','psql','-U','postgres','-d',db,'-At','-c',"select proname,proconfig from pg_proc where proname='gf_shop_slug_canonical'; select json_build_object('locations',(select count(*) from locations),'tickets',(select count(*) from tickets),'payments',(select count(*) from payments),'payment_total',(select sum(amount_cents) from payments),'forced_rls',(select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relrowsecurity and c.relforcerowsecurity));"])
(p/'pristine-restore.json').write_text(json.dumps(steps,indent=2))
for s in steps:print(s['command'][0],s['exitCode'],s['output'][-500:])
