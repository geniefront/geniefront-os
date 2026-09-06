import json,pathlib,re,statistics,hashlib
root=pathlib.Path('/private/tmp/copilot-vision-benchmark-20260906')
truth=json.loads((root/'ground-truth.json').read_text())['items']
def norm(s):
 return re.sub(r'[^a-z0-9]+','',s.lower())
def rowpairs(row,merged=False):
 variants=row.get('variants',[])
 if merged:
  return [(v.get('durationMin') or 0,v['priceCents']) for v in variants] if variants else [(row.get('durationMin') or 0,row.get('priceCents') or 0)]
 return [(v['duration_min'],v['price_cents']) for v in variants] if variants else [(row['duration_min'],row['price_cents'])]
def score(rows,merged=False):
 matches=[];used=set();correct=0;missing=[];wrong=[];kindwrong=[];extra=[];namechanges=[]
 for t in truth:
  candidates=[]
  for i,r in enumerate(rows):
   name=next(iter(r['name'].values())) if merged else r['name']
   # Explicit manual adjudication: the photo states couples prices are for relaxation.
   # Count this as the same priced offer, but report the non-verbatim name separately.
   matchname=norm(name)==norm(t['name']) or (t['id']=='couples' and norm(name)=='couplesmassagerelaxation')
   if matchname and norm(r.get('category') or '')==norm(t['category']):candidates.append((i,r))
  if not candidates:
   missing.append(t['id']);continue
  i,r=candidates[0];used.add(i);matches.append(t['id'])
  actualname=next(iter(r['name'].values())) if merged else r['name']
  if norm(actualname)!=norm(t['name']):namechanges.append({'id':t['id'],'expected':t['name'],'actual':actualname})
  expected=[(d,round(p*100)) for d,p in t['pairs']];actual=rowpairs(r,merged)
  for p in expected:
   if p in actual:correct+=1
   else:wrong.append({'id':t['id'],'expected':p,'actual':actual})
  for p in actual:
   if p not in expected:extra.append({'id':t['id'],'pair':p})
  if r['kind']!=t['kind']:kindwrong.append({'id':t['id'],'expected':t['kind'],'actual':r['kind']})
 unknown=[r['name'] for i,r in enumerate(rows) if i not in used and r['kind'] not in ('note','price_modifier')]
 return {'commercialEntitiesMatched':len(matches),'commercialEntitiesExpected':len(truth),'correctPriceDurationEntries':correct,'priceDurationEntriesExpected':sum(len(t['pairs']) for t in truth),'missingEntities':missing,'wrongEntries':wrong,'extraEntries':extra,'kindErrors':kindwrong,'unmatchedCommercialRows':unknown,'nonVerbatimNames':namechanges}
out=[]
for f in sorted(root.glob('*.json')):
 if not re.match(r'(luna|sonnet)-.*-\d+\.json',f.name):continue
 d=json.loads(f.read_text());rec={k:d.get(k) for k in ['id','provider','effort','actualModel','latencyMs','firstOutputMs','schemaValid','error','usage']}
 if d.get('extraction'):
  rec['raw']=score(d['extraction']['items']);rec['afterExistingMerge']=score(d['merged']['items'],True)
 out.append(rec)
(root/'scores.json').write_text(json.dumps(out,ensure_ascii=False,indent=2))
for x in out:print(json.dumps({k:v for k,v in x.items() if k!='usage'},ensure_ascii=False))
groups={}
for x in out:
 if not x.get('error'):groups.setdefault(x['provider']+'-'+x['effort'],[]).append(x)
summary=[]
for key,rows in groups.items():
 summary.append({'group':key,'n':len(rows),'latencyMedianSeconds':statistics.median(x['latencyMs'] for x in rows)/1000,'latencyRangeSeconds':[min(x['latencyMs'] for x in rows)/1000,max(x['latencyMs'] for x in rows)/1000],'firstOutputMedianSeconds':statistics.median(x['firstOutputMs'] for x in rows if x['firstOutputMs'] is not None)/1000,'rawCorrectEntries':[x['raw']['correctPriceDurationEntries'] for x in rows],'rawMatchedEntities':[x['raw']['commercialEntitiesMatched'] for x in rows],'afterMergeCorrectEntries':[x['afterExistingMerge']['correctPriceDurationEntries'] for x in rows]})
(root/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2));print(json.dumps(summary,ensure_ascii=False,indent=2))
