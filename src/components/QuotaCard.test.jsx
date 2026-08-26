import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '../test/dom.js';
import QuotaCard from './QuotaCard';

vi.mock('@stevederico/skateboard-ui/shadcn/ui/progress', () => ({
  Progress: ({ value, 'aria-label': label }) => (
    <div role="progressbar" aria-valuenow={value} aria-label={label} />
  ),
}));

const plan = {
  id: 'grok',
  name: 'Grok',
  plan: 'SuperGrok Heavy',
  ok: true,
  error: null,
  source: 'grok CLI billing',
  usedPercent: 84,
  resetsAt: '2026-08-27T19:20:27Z',
  bars: [
    { id: 'weekly', label: 'Weekly Pool', usedPercent: 84, resetsAt: '2026-08-27T19:20:27Z' },
  ],
};

describe('QuotaCard', () => {
  it('shows plan name and used percent', () => {
    render(<QuotaCard plan={plan} resetLabel={() => '1d'} />);
    expect(screen.getByText('Grok')).toBeInTheDocument();
    expect(screen.getByText('Limits')).toBeInTheDocument();
    expect(screen.getByText('Weekly Pool')).toBeInTheDocument();
  });

  it('shows headline and stats when there is no percent cap', () => {
    render(
      <QuotaCard
        plan={{
          id: 'opencode',
          name: 'OpenCode',
          plan: 'CLI',
          ok: true,
          error: null,
          source: 'opencode db',
          usedPercent: null,
          headline: '$0.63',
          stats: [{ id: 'sessions', label: 'Sessions', value: '25' }],
          resetsAt: null,
          bars: [],
        }}
        resetLabel={() => null}
      />
    );
    expect(screen.getByText('$0.63')).toBeInTheDocument();
    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(screen.getByText('25')).toBeInTheDocument();
  });
});
