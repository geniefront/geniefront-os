import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { BodyMapSelector } from './BodyMapSelector';
import { LanguageProvider } from '../context/LanguageContext';

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <LanguageProvider>{children}</LanguageProvider>
);

describe('BodyMapSelector Component', () => {
  it('cycles body part states on tap: none -> focus -> avoid -> none', () => {
    let currentValue = { focus: [] as string[], avoid: [] as string[] };
    const handleChange = vi.fn((val) => {
      currentValue = val;
    });

    const { rerender } = render(
      <BodyMapSelector value={currentValue} onChange={handleChange} />,
      { wrapper },
    );

    const headPart = screen.getByTestId('part-head');
    expect(headPart).toBeDefined();

    // 1st click: Focus
    fireEvent.click(headPart);
    expect(handleChange).toHaveBeenCalledWith({
      focus: ['Head/Face'],
      avoid: [],
    });

    // 2nd click: Avoid
    rerender(<BodyMapSelector value={{ focus: ['Head/Face'], avoid: [] }} onChange={handleChange} />);
    fireEvent.click(headPart);
    expect(handleChange).toHaveBeenCalledWith({
      focus: [],
      avoid: ['Head/Face'],
    });

    // 3rd click: None
    rerender(<BodyMapSelector value={{ focus: [], avoid: ['Head/Face'] }} onChange={handleChange} />);
    fireEvent.click(headPart);
    expect(handleChange).toHaveBeenCalledWith({
      focus: [],
      avoid: [],
    });
  });

  it('renders clear all button when items are selected and resets selection', () => {
    const handleChange = vi.fn();
    render(
      <BodyMapSelector
        value={{ focus: ['Left Shoulder'], avoid: ['Lower Back'] }}
        onChange={handleChange}
      />,
      { wrapper },
    );

    const clearBtn = screen.getByRole('button');
    expect(clearBtn).toBeDefined();
    fireEvent.click(clearBtn);
    expect(handleChange).toHaveBeenCalledWith({ focus: [], avoid: [] });
  });
});
