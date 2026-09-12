import { describe,it,expect,vi,afterEach } from 'vitest';
import { lookup } from 'node:dns/promises';
import { privateIp,fetchWebsitePages } from './websiteFetch';
vi.mock('node:dns/promises',()=>({lookup:vi.fn()}));
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});
describe('#10 website network address validation',()=>{
 it.each(['127.0.0.1','10.0.0.1','172.16.0.1','192.168.0.1','169.254.169.254','::1','::','fe80::1','febf::1','fd00::1','::ffff:127.0.0.1','::ffff:7f00:1','0:0:0:0:0:ffff:a00:1','::ffff:169.254.169.254'])('blocks %s',ip=>expect(privateIp(ip)).toBe(true));
 it.each(['8.8.8.8','2606:4700:4700::1111','::ffff:8.8.8.8'])('allows public %s',ip=>expect(privateIp(ip)).toBe(false));
 it('rejects mapped private DNS answers before fetch',async()=>{
  vi.mocked(lookup).mockResolvedValue([{address:'::ffff:127.0.0.1',family:6}] as any);
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
  await expect(fetchWebsitePages('https://example.com')).rejects.toMatchObject({details:{reason:'private_website_address'}});
  expect(fetcher).not.toHaveBeenCalled();
 });
 it('revalidates redirects and blocks a private destination',async()=>{
  vi.mocked(lookup).mockResolvedValueOnce([{address:'8.8.8.8',family:4}] as any).mockResolvedValueOnce([{address:'::ffff:10.0.0.1',family:6}] as any);
  const fetcher=vi.fn().mockResolvedValue(new Response(null,{status:302,headers:{location:'https://redirect.example'}}));vi.stubGlobal('fetch',fetcher);
  await expect(fetchWebsitePages('https://example.com')).rejects.toMatchObject({details:{reason:'private_website_address'}});expect(fetcher).toHaveBeenCalledTimes(1);
 });
});
