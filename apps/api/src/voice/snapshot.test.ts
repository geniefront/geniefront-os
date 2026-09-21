import {it,expect,vi} from 'vitest';
import {snapshotReader} from './snapshot';
it('shares identical reads only inside one snapshot and never caches writes or fragments',async()=>{
 const query=vi.fn(async()=>[]);const tx=query as any;
 const read=snapshotReader(tx);
 await Promise.all([read`select name from services where id=${'one'}`,read`select name from services where id=${'one'}`]);
 expect(query).toHaveBeenCalledTimes(1);
 await read`select name from services where id=${'two'}`;
 expect(query).toHaveBeenCalledTimes(2);
 await read`update services set name=${'x'}`;await read`update services set name=${'x'}`;
 expect(query).toHaveBeenCalledTimes(4);
 await snapshotReader(tx)`select name from services where id=${'one'}`;
 expect(query).toHaveBeenCalledTimes(5);
 const fragment={sql:'unsafe-to-cache'};
 await read`select name from services ${fragment as any}`;await read`select name from services ${fragment as any}`;
 expect(query).toHaveBeenCalledTimes(7);
});
