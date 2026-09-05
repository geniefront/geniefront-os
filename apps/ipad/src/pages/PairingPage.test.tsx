import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { PairingPage } from './PairingPage';
import { LanguageProvider } from '../context/LanguageContext';
import { DeviceAuthProvider } from '../context/DeviceAuthContext';
import { MemoryRouter } from 'react-router-dom';

describe('PairingPage Component', () => {
  it('renders pairing instructions and keypad input', () => {
    render(
      <MemoryRouter>
        <LanguageProvider>
          <DeviceAuthProvider>
            <PairingPage />
          </DeviceAuthProvider>
        </LanguageProvider>
      </MemoryRouter>,
    );

    expect(screen.getByText('iPad 自助终端入网配对')).toBeInTheDocument();
    expect(screen.getByText('完成门店绑定')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument();
  });

  it('空配对码点完成绑定时给出校验提示', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <LanguageProvider>
          <DeviceAuthProvider>
            <PairingPage />
          </DeviceAuthProvider>
        </LanguageProvider>
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: '完成门店绑定' }));
    expect(screen.getByText('请输入 6 位配对码')).toBeInTheDocument();
  });
});
