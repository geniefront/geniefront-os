import {render,screen,waitFor} from '@testing-library/react';
import {MemoryRouter,Routes,Route} from 'react-router-dom';
import {beforeEach,it,expect,vi} from 'vitest';
import {StaffBookingLink} from './StaffBookingLink';
const mocks=vi.hoisted(()=>({get:vi.fn(),select:vi.fn()}));
vi.mock('@/lib/session',()=>({useSession:()=>({locations:[{membershipId:'wrong'},{membershipId:'right'}],selectMembership:mocks.select})}));
vi.mock('@/LanguageContext',()=>({useLanguage:()=>({t:(key:string)=>key})}));
vi.mock('@/lib/api',()=>({apiGet:mocks.get,ApiError:class extends Error{status=404;}}));
beforeEach(()=>{mocks.get.mockReset();mocks.select.mockReset();});
it('uses only available memberships and opens the authorized appointment in the admin workspace',async()=>{
 const {ApiError}=await import('@/lib/api');
 mocks.get.mockRejectedValueOnce(new ApiError('NOT_FOUND',{},false,404)).mockResolvedValueOnce({appointmentId:'booking-id',locationId:'shop-id'});
 render(<MemoryRouter initialEntries={['/b/0123456789abcdef']}><Routes><Route path="/b/:code" element={<StaffBookingLink/>}/><Route path="/schedule" element={<p>Appointment opened</p>}/></Routes></MemoryRouter>);
 await screen.findByText('Appointment opened');
 expect(mocks.get.mock.calls.map(c=>c[1])).toEqual(['wrong','right']);
 expect(mocks.select).toHaveBeenCalledWith('right','admin');
});
it('shows an unavailable message without switching membership when no tenant can resolve the code',async()=>{
 const {ApiError}=await import('@/lib/api');mocks.get.mockRejectedValue(new ApiError('NOT_FOUND',{},false,404));
 render(<MemoryRouter initialEntries={['/b/0123456789abcdef']}><Routes><Route path="/b/:code" element={<StaffBookingLink/>}/></Routes></MemoryRouter>);
 await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('bookingLinkUnavailable'));
 expect(mocks.select).not.toHaveBeenCalled();
});
