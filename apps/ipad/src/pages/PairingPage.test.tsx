import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { PairingPage } from './PairingPage';
import { LanguageProvider } from '../context/LanguageContext';
import { DeviceAuthProvider } from '../context/DeviceAuthContext';
import { MemoryRouter } from 'react-router-dom';

describe('PairingPage Component', () => {
  it('renders pairing instructions and keypad', () => {
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
  });
});
