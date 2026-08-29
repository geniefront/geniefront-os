import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { VirtualKeypad } from './VirtualKeypad';

describe('VirtualKeypad Component', () => {
  it('triggers onKeyPress with appropriate digits when buttons are tapped', () => {
    const handleKeyPress = vi.fn();
    const handleDelete = vi.fn();
    const handleClear = vi.fn();

    render(
      <VirtualKeypad
        onKeyPress={handleKeyPress}
        onDelete={handleDelete}
        onClear={handleClear}
      />,
    );

    const btn1 = screen.getByText('1');
    const btn5 = screen.getByText('5');
    const btn9 = screen.getByText('9');
    const btn0 = screen.getByText('0');

    fireEvent.click(btn1);
    fireEvent.click(btn5);
    fireEvent.click(btn9);
    fireEvent.click(btn0);

    expect(handleKeyPress).toHaveBeenCalledWith('1');
    expect(handleKeyPress).toHaveBeenCalledWith('5');
    expect(handleKeyPress).toHaveBeenCalledWith('9');
    expect(handleKeyPress).toHaveBeenCalledWith('0');
  });

  it('triggers onDelete and onClear correctly', () => {
    const handleKeyPress = vi.fn();
    const handleDelete = vi.fn();
    const handleClear = vi.fn();

    const { container } = render(
      <VirtualKeypad
        onKeyPress={handleKeyPress}
        onDelete={handleDelete}
        onClear={handleClear}
      />,
    );

    const buttons = container.querySelectorAll('button');
    // Clear is 10th button (idx 9), Del is 12th button (idx 11)
    fireEvent.click(buttons[9]!);
    expect(handleClear).toHaveBeenCalledTimes(1);

    fireEvent.click(buttons[11]!);
    expect(handleDelete).toHaveBeenCalledTimes(1);
  });
});
