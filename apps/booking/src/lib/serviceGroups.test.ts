import {expect,it} from 'vitest';
import {groupServices} from './serviceGroups';
const service=(id:string,name:string,categoryId='massage')=>({id,name,categoryId,durationMin:id==='a'?60:30,priceCents:6000,description:null,isAddon:false});
it('groups explicit duration variants, preserving real IDs and categories',()=>{
 const groups=groupServices([service('a','Swedish Massage 60 min'),service('b','Swedish Massage 30 min'),service('c','Swedish Massage 30 min','other')]);
 expect(groups).toHaveLength(2);expect(groups[0]?.name).toBe('Swedish Massage');expect(groups[0]?.services.map(s=>s.id)).toEqual(['b','a']);
});
it('supports Chinese duration suffixes without merging different treatments',()=>{
 expect(groupServices([service('a','瑞典式按摩 60 分钟'),service('b','瑞典式按摩 30 分钟')])).toHaveLength(1);
 expect(groupServices([service('a','Deep Tissue'),service('b','Swedish Massage')])).toHaveLength(2);
});
