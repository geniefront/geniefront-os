import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {it,expect,vi} from 'vitest';
import {PendingBookingAssignments} from './PendingBookingAssignments';
const mocks=vi.hoisted(()=>({assign:vi.fn().mockResolvedValue({}),changed:vi.fn()}));
vi.mock('@/LanguageContext',()=>({useLanguage:()=>({t:(key:string)=>key})}));
vi.mock('@/lib/permissions',()=>({useCan:()=>true}));
vi.mock('@/lib/errorMessage',()=>({useErrorMessage:()=>String}));
vi.mock('@heroui/react',()=>({toast:{danger:vi.fn()}}));
vi.mock('@/components/ui/Button',()=>({Button:({children,...props}:any)=><button {...props}>{children}</button>}));
vi.mock('./api',()=>({useRescheduleAppointment:()=>({mutateAsync:mocks.assign,isPending:false})}));
it('offers only pending items and assigns the selected item without changing its time',async()=>{
 const startsAt='2026-10-01T14:00:00Z';
 render(<PendingBookingAssignments appointmentId="booking" date="2026-10-01" items={[
  {itemId:'requested',serviceName:'Requested massage',staffId:'a',startsAt},
  {itemId:'pending',serviceName:'Pending massage',staffId:null,startsAt},
 ]} staff={[{membershipId:'a',name:'Alice'},{membershipId:'b',name:'Bob'}]} onChanged={mocks.changed}/>);
 expect(screen.queryByText('Requested massage')).not.toBeInTheDocument();
 fireEvent.change(screen.getByRole('combobox'),{target:{value:'b'}});
 fireEvent.click(screen.getByRole('button'));
 await waitFor(()=>expect(mocks.changed).toHaveBeenCalled());
 expect(mocks.assign).toHaveBeenCalledWith({appointmentId:'booking',itemId:'pending',startsAt,membershipId:'b'});
});
