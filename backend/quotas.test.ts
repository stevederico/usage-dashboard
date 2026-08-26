import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampPercent,
  formatReset,
  formatTokenCount,
  parseClaudeCache,
  parseCursorUsage,
  parseGrokBilling,
  parseOpenCodeTotals,
  planLabelFromTier,
} from './quotas.ts';

describe('clampPercent', () => {
  it('clamps over 100', () => {
    assert.equal(clampPercent(140), 100);
  });

  it('treats NaN as 0', () => {
    assert.equal(clampPercent(Number.NaN), 0);
  });
});

describe('planLabelFromTier', () => {
  it('maps Claude 5x tier', () => {
    assert.equal(planLabelFromTier('default_claude_max_5x'), 'Max 5x');
  });
});

describe('formatReset', () => {
  it('formats hours remaining', () => {
    const now = Date.parse('2026-08-26T12:00:00Z');
    assert.equal(formatReset('2026-08-27T12:00:00Z', now), '24h');
  });
});

describe('parseGrokBilling', () => {
  it('reads weekly percent and product bars', () => {
    const plan = parseGrokBilling({
      config: {
        currentPeriod: {
          type: 'USAGE_PERIOD_TYPE_WEEKLY',
          start: '2026-08-20T19:20:27.042381+00:00',
          end: '2026-08-27T19:20:27.042381+00:00',
        },
        creditUsagePercent: 84,
        productUsage: [
          { product: 'GrokBuild', usagePercent: 69 },
          { product: 'GrokChat', usagePercent: 10 },
        ],
      },
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.usedPercent, 84);
    assert.equal(plan.bars[0]?.label, 'Weekly Pool');
    assert.equal(plan.bars[1]?.label, 'Grok Build');
    assert.equal(plan.bars[1]?.usedPercent, 69);
  });
});

describe('parseCursorUsage', () => {
  it('maps auto and api percents', () => {
    const plan = parseCursorUsage({
      billingCycleEnd: '1787947174893',
      planUsage: {
        autoPercentUsed: 12.5,
        apiPercentUsed: 3,
        totalPercentUsed: 12.5,
      },
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.usedPercent, 12.5);
    assert.equal(plan.bars[0]?.label, 'Cursor Models');
    assert.equal(plan.bars[1]?.usedPercent, 3);
  });
});

describe('formatTokenCount', () => {
  it('formats millions', () => {
    assert.equal(formatTokenCount(4_373_448), '4.4M');
  });
});

describe('parseOpenCodeTotals', () => {
  it('reads cost and token stats', () => {
    const plan = parseOpenCodeTotals([
      { sessions: 25, cost: 0.63, input: 4373448, output: 151216 },
    ]);
    assert.equal(plan.ok, true);
    assert.equal(plan.headline, '$0.63');
    assert.equal(plan.stats[0]?.value, '25');
    assert.equal(plan.stats[1]?.value, '4.4M');
  });
});

describe('parseClaudeCache', () => {
  it('reads Max 5x session and week bars', () => {
    const plan = parseClaudeCache({
      oauthAccount: { organizationRateLimitTier: 'default_claude_max_5x' },
      cachedUsageUtilization: {
        fetchedAtMs: Date.now(),
        utilization: {
          five_hour: {
            utilization: 39,
            resets_at: '2026-08-26T22:00:00Z',
          },
          seven_day: {
            utilization: 49,
            resets_at: '2026-08-31T00:00:00Z',
          },
          limits: [
            {
              kind: 'weekly_scoped',
              percent: 66,
              resets_at: '2026-08-31T00:00:00Z',
              scope: { model: { display_name: 'Fable' } },
            },
          ],
        },
      },
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.plan, 'Max 5x');
    assert.equal(plan.usedPercent, 49);
    assert.equal(plan.bars.length, 3);
    assert.equal(plan.bars[2]?.label, 'Fable');
  });
});
