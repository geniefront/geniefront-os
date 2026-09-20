import {afterEach,expect,it,vi} from 'vitest';
import {getServices,setPublicKey} from './api';
afterEach(()=>{vi.unstubAllGlobals();setPublicKey('');});
it('binds a request to its shop even if another bootstrap changed the global fallback',async()=>{
  const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({categories:[],services:[],addons:[]})));
  vi.stubGlobal('fetch',fetch);
  setPublicKey('pk_previous_shop');
  await getServices('en','pk_current_shop');
  expect(fetch.mock.calls[0]![1].headers['X-GF-Public-Key']).toBe('pk_current_shop');
});
