import http from 'node:http';
import dns from 'node:dns';
import promises from 'node:dns/promises';
import {syncBuiltinESMExports} from 'node:module';
let received=0,checks=0,connections=0;
const server=http.createServer((_req,res)=>{received++;res.writeHead(200,{'Content-Type':'text/html'});res.end('<html><body>isolated audit internal page</body></html>');});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const originalPromise=promises.lookup,originalLookup=dns.lookup;
(promises as any).lookup=async (host:any,opts:any)=>{if(host==='audit-rebind.invalid'){checks++;return [{address:'93.184.216.34',family:4}];}return originalPromise(host,opts);};
(dns as any).lookup=(host:any,opts:any,cb:any)=>{if(host==='audit-rebind.invalid'){connections++;const done=typeof opts==='function'?opts:cb;return done(null,opts?.all?[{address:'127.0.0.1',family:4}]:'127.0.0.1',4);}return originalLookup(host,opts,cb);};
syncBuiltinESMExports();
try{
 const {fetchWebsitePages}=await import('/Users/naiyouzhu/siteadmin/geniefront-os/apps/api/src/onboarding/websiteFetch.ts');
 const pages=await fetchWebsitePages(`http://audit-rebind.invalid:${(server.address() as any).port}`);
 console.log(JSON.stringify({validationPublicResults:checks,connectionLookups:connections,internalRequests:received,internalContentReturned:pages[0]?.text==='isolated audit internal page'}));
}finally{promises.lookup=originalPromise;dns.lookup=originalLookup;syncBuiltinESMExports();server.closeAllConnections();server.close();}
