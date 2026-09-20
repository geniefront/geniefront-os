import {render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {expect,it,vi} from 'vitest';
import {ServiceCustomizer} from './ServiceCustomizer';
const base={categoryId:'massage',description:null,isAddon:false};
it('edits the actual variant and add-ons together, without saving on dismiss',async()=>{
 const user=userEvent.setup(),save=vi.fn(),close=vi.fn();
 render(<ServiceCustomizer group={{key:'swedish',name:'Swedish Massage',services:[{...base,id:'short',name:'Swedish 30 min',durationMin:30,priceCents:4500},{...base,id:'long',name:'Swedish 60 min',durationMin:60,priceCents:6000}]}} addons={[{...base,id:'oil',name:'Essential Oils',durationMin:10,priceCents:1000,isAddon:true}]} currency="USD" onClose={close} onSave={save}/>);
 await user.click(screen.getByRole('button',{name:'60 min $60'}));
 await user.click(screen.getByRole('checkbox',{name:'Essential Oils'}));
 expect(save).not.toHaveBeenCalled();
 await user.click(screen.getByRole('button',{name:'Add to booking · $70'}));
 expect(save).toHaveBeenCalledWith('long',['oil']);
});
