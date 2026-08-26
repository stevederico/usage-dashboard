import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '../test/dom.js';
import HomeView from './HomeView.jsx';

vi.mock('@stevederico/skateboard-ui/Header', () => ({
  default: ({ title, children }) => (
    <header data-testid="header">
      {title}
      {children}
    </header>
  ),
}));

vi.mock('@stevederico/skateboard-ui/Utilities', () => ({
  useListData: () => ({
    data: {
      fetchedAt: '2026-08-26T00:00:00Z',
      plans: [
        {
          id: 'grok',
          name: 'Grok',
          plan: 'SuperGrok Heavy',
          ok: true,
          error: null,
          source: 'grok CLI billing',
          usedPercent: 84,
          resetsAt: null,
          bars: [],
        },
      ],
    },
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock('./QuotaCard.jsx', () => ({
  default: ({ plan }) => <div data-testid="quota-card">{plan.name}</div>,
}));

describe('HomeView', () => {
  it('renders usage header and plan cards', () => {
    render(<HomeView />);

    expect(screen.getByTestId('header')).toHaveTextContent('Usage');
    expect(screen.getByTestId('quota-card')).toHaveTextContent('Grok');
  });
});
