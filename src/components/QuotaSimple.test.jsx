import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '../test/dom.js';
import QuotaSimple from './QuotaSimple';

vi.mock('@stevederico/skateboard-ui/shadcn/ui/progress', () => ({
  Progress: ({ value, 'aria-label': label }) => (
    <div role="progressbar" aria-valuenow={value} aria-label={label} />
  ),
}));

const plans = [
  {
    id: 'grok',
    name: 'Grok',
    plan: 'SuperGrok Heavy',
    ok: true,
    error: null,
    source: 'grok CLI billing',
    usedPercent: 86,
    resetsAt: null,
    bars: [],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    plan: 'CLI',
    ok: true,
    error: null,
    source: 'opencode db',
    usedPercent: null,
    headline: '$0.63',
    resetsAt: null,
    bars: [],
  },
];

describe('QuotaSimple', () => {
  it('stacks service names and values', () => {
    render(<QuotaSimple plans={plans} />);
    expect(screen.getByText('Grok')).toBeInTheDocument();
    expect(screen.getByText('86%')).toBeInTheDocument();
    expect(screen.getByText('OpenCode')).toBeInTheDocument();
    expect(screen.getByText('$0.63')).toBeInTheDocument();
  });
});
