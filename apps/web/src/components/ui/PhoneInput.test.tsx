import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { PhoneInput } from '@gf/phone-input';
function Harness() { const [v, setV] = useState(''); return <PhoneInput aria-label="Phone" value={v} onChange={e => setV(e.target.value)} />; }
it('defaults to +1 and allows clearing and entering another international prefix', async () => {
  render(<Harness />); const field = screen.getByRole('textbox'); const user = userEvent.setup();
  expect(field).toHaveValue('+1');
  await user.clear(field); await user.type(field, '+447911123456'); await user.tab();
  expect(field).toHaveValue('+44 7911 123456');
  expect(field).not.toHaveAttribute('aria-invalid', 'true');
});
it('rejects letters instead of silently turning a bad paste into a different number', () => {
  const change = vi.fn(); render(<PhoneInput aria-label="Phone" value="" onChange={change} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'abc6676606667' } });
  expect(change).not.toHaveBeenCalled(); expect(screen.getByRole('alert')).toBeVisible();
});
it('does not silently truncate overlong numbers, and flags them on blur', () => {
  render(<Harness />); const field=screen.getByRole('textbox');
  fireEvent.focus(field); fireEvent.change(field,{target:{value:'+166766066671234567'}}); fireEvent.blur(field);
  expect(field).toHaveValue('+166766066671234567'); expect(field).toHaveAttribute('aria-invalid','true');
});
