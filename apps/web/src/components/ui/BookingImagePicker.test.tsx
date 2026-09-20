import {render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {expect,it,vi} from 'vitest';
import {useState} from 'react';
import {BookingImagePicker} from './BookingImagePicker';
vi.mock('@/LanguageContext',async()=>{const {settings}=await import('@/i18n/settings');return {useLanguage:()=>({language:'en',t:(key:string)=>(settings as any)[key]?.en??key})};});
vi.mock('./ImageUploader',()=>({ImageUploader:({value,onChange}:any)=><div><img alt="Preview" src={value}/><button onClick={()=>onChange('https://example.com/custom.jpg')}>Upload own photo</button></div>}));
it('supports automatic category images, library selection and custom upload',async()=>{
 const user=userEvent.setup();function Demo(){const [value,setValue]=useState('');return <BookingImagePicker value={value} onChange={setValue} serviceName="Foot Massage"/>;}
 render(<Demo/>);expect(screen.getByAltText('Preview')).toHaveAttribute('src',expect.stringContaining('foot-v1.jpg'));
 await user.click(screen.getByText('Choose a library image'));
 await user.selectOptions(screen.getByRole('combobox',{name:'Image category'}),'hot-stones');
 await user.click(screen.getByRole('button',{name:'Hot stones'}));
 expect(screen.getByAltText('Preview')).toHaveAttribute('src',expect.stringContaining('hot-stones-v1.jpg'));
 await user.click(screen.getByRole('button',{name:'Upload own photo'}));
 expect(screen.getByAltText('Preview')).toHaveAttribute('src','https://example.com/custom.jpg');
});
