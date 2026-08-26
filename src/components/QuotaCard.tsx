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
 * Plan usage card with percent bars.
 *
 * @param props - Plan + reset formatter
 * @returns Card
 */
export default function QuotaCard({ plan, resetLabel }: QuotaCardProps) {
  const used = plan.usedPercent;
  const headline = plan.headline ?? null;
  const stats = plan.stats ?? [];
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
      <CardContent className="flex flex-col gap-4">
        {plan.error ? (
          <p className="text-copy-sm text-destructive">{plan.error}</p>
        ) : null}
        {stats.map((stat) => (
          <div key={stat.id} className="flex items-center justify-between gap-2">
            <p className="text-label-sm">{stat.label}</p>
            <p className="text-copy-sm text-muted-foreground tabular-nums">{stat.value}</p>
          </div>
        ))}
        {plan.bars.map((bar) => {
          const reset = resetLabel(bar.resetsAt);
          return (
            <div key={bar.id} className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-label-sm">{bar.label}</p>
                <p className="text-copy-sm text-muted-foreground tabular-nums">
                  {Math.round(bar.usedPercent)}%
                  {reset ? ` · ${reset}` : ''}
                </p>
              </div>
              <Progress
                value={bar.usedPercent}
                aria-label={`${bar.label} ${Math.round(bar.usedPercent)} percent used`}
              />
            </div>
          );
        })}
        {plan.source ? (
          <p className="text-copy-sm text-muted-foreground">{plan.source}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
