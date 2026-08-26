import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '../test/dom.js';
import SettingsView from './SettingsView';

vi.mock('@stevederico/skateboard-ui/SettingsView', () => ({
  default: () => <div data-testid="shell-settings">Shell</div>,
}));

vi.mock('@stevederico/skateboard-ui/shadcn/ui/select', () => ({
  Select: ({ children, value }) => <div data-testid="refresh-select" data-value={value}>{children}</div>,
  SelectTrigger: ({ children }) => <div>{children}</div>,
  SelectValue: () => <span>5 Minutes</span>,
  SelectContent: ({ children }) => <div>{children}</div>,
  SelectItem: ({ children }) => <div>{children}</div>,
}));

describe('SettingsView', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('shows the refresh interval control', () => {
    render(<SettingsView />);
    expect(screen.getByText('Usage Refresh')).toBeInTheDocument();
    expect(screen.getByText('Refresh Interval')).toBeInTheDocument();
  });
});
