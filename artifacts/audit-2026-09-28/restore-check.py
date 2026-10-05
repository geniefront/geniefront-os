import subprocess,json,pathlib
out=pathlib.Path(__file__).resolve().parent
container='gf-audit-20260928'
dump='/tmp/gf-audit-20260928.dump'
results=[]
def run(args,input_dump=False):
 with open(dump,'rb') if input_dump else open('/dev/null','rb') as src:
  r=subprocess.run(['docker','exec','-i',container,*args],stdin=src,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
 results.append({'args':args,'exitCode':r.returncode,'output':r.stdout.decode()});return r.returncode
run(['createdb','-U','postgres','audit_restore_repro'])
run(['pg_restore','-U','postgres','-d','audit_restore_repro','--exit-on-error'],True)
run(['createdb','-U','postgres','audit_restore_control'])
if run(['pg_restore','-U','postgres','-d','audit_restore_control','--section=pre-data','--exit-on-error'],True)==0:
 run(['psql','-U','postgres','-d','audit_restore_control','-v','ON_ERROR_STOP=1','-c','alter function public.gf_shop_slug_canonical(text) set search_path=public,pg_catalog;'])
 if run(['pg_restore','-U','postgres','-d','audit_restore_control','--section=data','--exit-on-error'],True)==0:
  run(['pg_restore','-U','postgres','-d','audit_restore_control','--section=post-data','--exit-on-error'],True)
  for db in ['postgres','audit_restore_control']:
   run(['psql','-U','postgres','-d',db,'-At','-c',"select json_build_object('locations',(select count(*) from locations),'tickets',(select count(*) from tickets),'payments',(select count(*) from payments),'payment_total',(select sum(amount_cents) from payments),'refund_total',(select sum(amount_cents) from ticket_refunds),'forced_rls',(select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relrowsecurity and c.relforcerowsecurity));"])
(out/'restore-check.json').write_text(json.dumps(results,indent=2))
for r in results: print(r['args'][0],r['exitCode'],r['output'][:400])
