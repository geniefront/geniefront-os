import { resolveTxt } from 'node:dns/promises';
import { domainToASCII } from 'node:url';
export function normalizeEmailDomain(value:string):string {
  const d=domainToASCII(value.trim().toLowerCase().replace(/\.$/,''));
  if(d.length>253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d)
    || d==='geniefront.com' || d.endsWith('.geniefront.com')) throw new Error('invalid_or_platform_domain');
  return d;
}
export const ELASTIC_DKIM='k=rsa;t=s;p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCbmGbQMzYeMvxwtNQoXN0waGYaciuKx8mtMh5czguT4EZlJXuCt6V+l56mmt3t68FEX5JJ0q4ijG71BGoFRkl87uJi7LrQt1ZZmZCvrEII0YO4mp8sDLXC8g1aUAoi8TJgxq2MJqCaMyj5kAm3Fdy2tzftPCV/lbdiJqmBnWKjtwIDAQAB';
export async function txtRecords(name:string):Promise<string[]> {
  try{return (await resolveTxt(name)).map(x=>x.join(''));}catch{return [];}
}
export interface DnsInstruction {type:string;name:string;value:string;action:string;required:boolean;}
export async function domainInstructions(domain:string,token:string):Promise<DnsInstruction[]> {
  const spfs=(await txtRecords(domain)).filter(x=>/^v=spf1\b/i.test(x));
  const dmarc=(await txtRecords(`_dmarc.${domain}`)).find(x=>/^v=DMARC1/i.test(x));
  let spf=spfs[0] || 'v=spf1 include:_spf.elasticemail.com ~all';
  let spfAction=spfs.length>1?'conflict':spfs.length?'present':'add';
  if(spfs.length===1 && !spf.includes('include:_spf.elasticemail.com')) {
    if(/\bredirect=/i.test(spf)) {
      // redirect 策略必须人工处理：这里保留现有记录原值，不产出会被直接复制的改写结果。
      spfAction='manual_review';
    } else {
      spf=spf.replace(/\s+[~?+-]?all\s*$/i,'')+' include:_spf.elasticemail.com '+(spf.match(/[~?+-]?all\s*$/i)?.[0]?.trim() || '~all');
      spfAction='merge';
    }
  }
  return [
    {type:'TXT',name:`_geniefront.${domain}`,value:`gf-domain=${token}`,action:'ownership',required:true},
    {type:'TXT',name:domain,value:spf,action:spfAction,required:true},
    {type:'TXT',name:`api._domainkey.${domain}`,value:ELASTIC_DKIM,action:'check_existing',required:true},
    {type:'TXT',name:`_dmarc.${domain}`,value:dmarc || 'v=DMARC1; p=none;',action:dmarc?'preserve':'add',required:true},
    {type:'CNAME',name:`tracking.${domain}`,value:'api.elasticemail.com',action:'optional_dns_only',required:false},
  ];
}
