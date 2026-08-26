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
    resetsAt: new Date(Date.now() + 2 * 86_400_000 + 5 * 3_600_000).toISOString(),
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
    const { container } = render(<QuotaSimple plans={plans} />);
    expect(screen.getByText('Grok')).toBeInTheDocument();
    expect(screen.getByText(/86%/)).toBeInTheDocument();
    expect(screen.getByText(/2d 5h/)).toBeInTheDocument();
    expect(screen.getByText('OpenCode')).toBeInTheDocument();
    expect(screen.getByText('$0.63')).toBeInTheDocument();
    expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(2);
  });
});
