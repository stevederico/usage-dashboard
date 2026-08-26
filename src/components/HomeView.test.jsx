import { beforeEach, describe, it, expect, vi } from 'vitest';
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

vi.mock('./QuotaSimple.jsx', () => ({
  default: ({ plans }) => (
    <div data-testid="quota-simple">{plans.map((p) => p.name).join(' ')}</div>
  ),
}));

vi.mock('@stevederico/skateboard-ui/shadcn/ui/tabs', () => ({
  Tabs: ({ children, value, onValueChange }) => (
    <div data-testid="tabs" data-value={value}>
      <button type="button" onClick={() => onValueChange('advanced')}>
        Advanced
      </button>
      {children}
    </div>
  ),
  TabsList: ({ children }) => <div>{children}</div>,
  TabsTrigger: ({ value, children }) => <span data-value={value}>{children}</span>,
}));

describe('HomeView', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to simple stacked rows', () => {
    render(<HomeView />);

    expect(screen.getByTestId('header')).toHaveTextContent('Usage');
    expect(screen.getByTestId('quota-simple')).toHaveTextContent('Grok');
    expect(screen.queryByTestId('quota-card')).not.toBeInTheDocument();
  });
});
