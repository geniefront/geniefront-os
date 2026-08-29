import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { HomePage } from './HomePage';
import { LanguageProvider } from '../context/LanguageContext';
import { DeviceAuthProvider } from '../context/DeviceAuthContext';
import { MemoryRouter } from 'react-router-dom';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<any>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

describe('HomePage Component', () => {
  it('renders core action cards and navigates on tap', () => {
    render(
      <MemoryRouter>
        <LanguageProvider>
          <DeviceAuthProvider>
            <HomePage />
          </DeviceAuthProvider>
        </LanguageProvider>
      </MemoryRouter>,
    );

    // 预约签到卡片
    const apptCard = screen.getByText('我有预约 · 签到');
    expect(apptCard).toBeInTheDocument();
    fireEvent.click(apptCard);
    expect(mockNavigate).toHaveBeenCalledWith('/check-in');

    // Walk-in 卡片
    const walkinCard = screen.getByText('无预约 · 现场排队取号');
    expect(walkinCard).toBeInTheDocument();
    fireEvent.click(walkinCard);
    expect(mockNavigate).toHaveBeenCalledWith('/walk-in');
  });

  it('switches language when language buttons are tapped', () => {
    render(
      <MemoryRouter>
        <LanguageProvider>
          <DeviceAuthProvider>
            <HomePage />
          </DeviceAuthProvider>
        </LanguageProvider>
      </MemoryRouter>,
    );

    const enButton = screen.getByText('English');
    fireEvent.click(enButton);

    expect(screen.getByText('I Have an Appointment')).toBeInTheDocument();
    expect(screen.getByText('Walk-in · Join Queue')).toBeInTheDocument();
  });
});
