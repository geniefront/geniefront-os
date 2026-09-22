import {expect,it,vi} from 'vitest';
vi.mock('./handlers/appointment',()=>({lockBookingCapacity:vi.fn()}));
import {assertCanDeactivateStaff} from './staffProtection';
const ctx={membershipId:'actor',userId:'user',locationId:'shop'} as any;
it('protects an owner or current user before checking appointments',async()=>{
 const tx=vi.fn().mockResolvedValueOnce([{protected:true}]);
 await expect(assertCanDeactivateStaff(tx as any,ctx,'owner')).rejects.toMatchObject({details:{reason:'protected_owner_or_self'}});
 expect(tx).toHaveBeenCalledTimes(1);
});
it('rejects foreign or missing memberships',async()=>{
 await expect(assertCanDeactivateStaff(vi.fn().mockResolvedValue([]) as any,ctx,'foreign')).rejects.toMatchObject({code:'NOT_FOUND'});
});
it('requires existing appointments to be handled before deactivation',async()=>{
 const tx=vi.fn().mockResolvedValueOnce([{protected:false}]).mockResolvedValueOnce([{id:'appointment'}]);
 await expect(assertCanDeactivateStaff(tx as any,ctx,'staff')).rejects.toMatchObject({details:{reason:'staff_has_upcoming_appointments'}});
});
it('allows an unprotected employee with no future appointments',async()=>{
 const tx=vi.fn().mockResolvedValueOnce([{protected:false}]).mockResolvedValueOnce([]);
 await expect(assertCanDeactivateStaff(tx as any,ctx,'staff')).resolves.toBeUndefined();
});
