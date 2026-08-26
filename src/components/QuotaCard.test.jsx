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
    expect(screen.getByText('84%')).toBeInTheDocument();
  });
});
