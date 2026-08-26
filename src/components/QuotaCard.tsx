import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@stevederico/skateboard-ui/shadcn/ui/card';
import { Progress } from '@stevederico/skateboard-ui/shadcn/ui/progress';
import { Badge } from '@stevederico/skateboard-ui/shadcn/ui/badge';
import { cn } from '@stevederico/skateboard-ui/shadcn/lib/utils';
import { formatTokenCount, weekdayLabel } from '../lib/format';

/** One usage bar on a plan card. */
export type QuotaBar = {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt: string | null;
};

/** A non-percent metric row. */
export type QuotaStat = {
  id: string;
  label: string;
  value: string;
};

/** One subscription snapshot from GET /quotas. */
export type PlanQuota = {
  id: string;
  name: string;
  plan: string;
  ok: boolean;
  error: string | null;
  source: string;
  usedPercent: number | null;
  headline?: string | null;
  stats?: QuotaStat[];
  resetsAt: string | null;
  bars: QuotaBar[];
  recentDays?: { date: string; tokens: number }[];
  models?: { name: string; total: number }[];
};

type QuotaCardProps = {
  plan: PlanQuota;
  resetLabel: (iso: string | null) => string | null;
};

/**
 * Color token for a used percent.
 *
 * @param used - 0–100
 * @returns Tailwind text class
 */
function usedTone(used: number): string {
  if (used >= 90) return 'text-destructive';
  if (used >= 70) return 'text-warning';
  return 'text-foreground';
}

/**
 * Section heading matching the Omarchy agents pane.
 *
 * @param props - Title
 * @returns Heading
 */
function SectionTitle({ children }: { children: string }) {
  return (
    <p className="text-label-sm text-muted-foreground tracking-wide">{children}</p>
  );
}

/**
 * Advanced plan card: limits, daily tokens, and models.
 *
 * @param props - Plan + reset formatter
 * @returns Card
 */
export default function QuotaCard({ plan, resetLabel }: QuotaCardProps) {
  const used = plan.usedPercent;
  const headline = plan.headline ?? null;
  const stats = plan.stats ?? [];
  const days = plan.recentDays ?? [];
  const models = plan.models ?? [];
  const dayPeak = Math.max(1, ...days.map((d) => d.tokens));
  const modelPeak = Math.max(1, models[0]?.total ?? 1);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>{plan.name}</CardTitle>
            <CardDescription>{plan.plan}</CardDescription>
          </div>
          {used !== null ? (
            <p className={cn('text-heading-lg tabular-nums', usedTone(used))}>
              {Math.round(used)}%
            </p>
          ) : headline ? (
            <p className="text-heading-lg tabular-nums">{headline}</p>
          ) : (
            <Badge variant="outline">Offline</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {plan.error ? (
          <p className="text-copy-sm text-destructive">{plan.error}</p>
        ) : null}

        {stats.length > 0 ? (
          <div className="flex flex-col gap-3">
            <SectionTitle>Balance</SectionTitle>
            {stats.map((stat) => (
              <div key={stat.id} className="flex items-center justify-between gap-2">
                <p className="text-label-sm">{stat.label}</p>
                <p className="text-copy-sm text-muted-foreground tabular-nums">{stat.value}</p>
              </div>
            ))}
          </div>
        ) : null}

        {plan.bars.length > 0 ? (
          <div className="flex flex-col gap-3">
            <SectionTitle>Limits</SectionTitle>
            {plan.bars.map((bar) => {
              const reset = resetLabel(bar.resetsAt);
              return (
                <div key={bar.id} className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-label-sm">{bar.label}</p>
                    <p className={cn('text-copy-sm tabular-nums', usedTone(bar.usedPercent))}>
                      {Math.round(bar.usedPercent)}%
                    </p>
                  </div>
                  <Progress
                    value={bar.usedPercent}
                    aria-label={`${bar.label} ${Math.round(bar.usedPercent)} percent used`}
                    className="[&_[data-slot=progress-track]]:bg-foreground/30"
                  />
                  {reset ? (
                    <p className="text-copy-sm text-muted-foreground">Resets In {reset}</p>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}

        {days.some((d) => d.tokens > 0) ? (
          <div className="flex flex-col gap-3">
            <SectionTitle>Tokens By Day</SectionTitle>
            {days.map((day) => (
              <div key={day.date} className="flex flex-col gap-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-label-sm">{weekdayLabel(day.date)}</p>
                  <p className="text-copy-sm text-muted-foreground tabular-nums">
                    {formatTokenCount(day.tokens)}
                  </p>
                </div>
                <Progress
                  value={(day.tokens / dayPeak) * 100}
                  aria-label={`${day.date} ${formatTokenCount(day.tokens)} tokens`}
                  className="[&_[data-slot=progress-track]]:bg-foreground/30"
                />
              </div>
            ))}
          </div>
        ) : null}

        {models.length > 0 ? (
          <div className="flex flex-col gap-3">
            <SectionTitle>Tokens By Model</SectionTitle>
            {models.map((model) => (
              <div key={model.name} className="flex flex-col gap-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-label-sm capitalize">{model.name}</p>
                  <p className="text-copy-sm text-muted-foreground tabular-nums">
                    {formatTokenCount(model.total)}
                  </p>
                </div>
                <Progress
                  value={(model.total / modelPeak) * 100}
                  aria-label={`${model.name} ${formatTokenCount(model.total)} tokens`}
                  className="[&_[data-slot=progress-track]]:bg-foreground/30"
                />
              </div>
            ))}
          </div>
        ) : null}

        {plan.source ? (
          <p className="text-copy-sm text-muted-foreground">{plan.source}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
