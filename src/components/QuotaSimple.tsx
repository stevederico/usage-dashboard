import { Progress } from '@stevederico/skateboard-ui/shadcn/ui/progress';
import { cn } from '@stevederico/skateboard-ui/shadcn/lib/utils';
import { formatPlanValue } from '../lib/format';
import type { PlanQuota } from './QuotaCard';

type QuotaSimpleProps = {
  plans: PlanQuota[];
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
 * Stacked one-line usage rows: service name and the headline number.
 *
 * @param props - Plans to list
 * @returns Simple list
 */
export default function QuotaSimple({ plans }: QuotaSimpleProps) {
  return (
    <section className="flex max-w-xl flex-col gap-5" aria-label="Usage">
      {plans.map((plan) => {
        const used = plan.usedPercent;
        const value = formatPlanValue(plan);
        return (
          <div key={plan.id} className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-4">
              <p className="text-label-md">{plan.name}</p>
              <p
                className={cn(
                  'text-label-md tabular-nums',
                  used !== null ? usedTone(used) : 'text-muted-foreground'
                )}
              >
                {value}
              </p>
            </div>
            {used !== null ? (
              <Progress
                value={used}
                aria-label={`${plan.name} ${value} used`}
              />
            ) : (
              <div className="bg-border h-0.5" />
            )}
          </div>
        );
      })}
    </section>
  );
}
