import Header from '@stevederico/skateboard-ui/Header';
import { useListData } from '@stevederico/skateboard-ui/Utilities';
import { Button } from '@stevederico/skateboard-ui/shadcn/ui/button';
import { Skeleton } from '@stevederico/skateboard-ui/ui/skeleton';
import QuotaCard from './QuotaCard';
import type { PlanQuota } from './QuotaCard';
import { formatReset } from '../lib/format';

/** GET /quotas payload. */
type QuotasResponse = {
  fetchedAt: string;
  plans: PlanQuota[];
};

/**
 * Local usage dashboard for Cursor Ultra, SuperGrok Heavy, and Claude Max.
 *
 * @returns Dashboard view
 */
export default function HomeView() {
  const { data, loading, error, refetch } = useListData('/quotas');
  const payload = isQuotas(data) ? data : null;

  return (
    <>
      <Header title="Usage">
        <Button size="sm" onClick={() => void refetch()} disabled={loading}>
          Refresh
        </Button>
      </Header>
      <main className="flex flex-1 flex-col gap-6 p-4 lg:p-6">
        {loading && !payload ? <HomeGridSkeleton /> : null}
        {error ? (
          <p className="text-copy-md text-destructive">{error}</p>
        ) : null}
        {payload ? (
          <section className="grid gap-4 md:grid-cols-3">
            {payload.plans.map((plan) => (
              <QuotaCard key={plan.id} plan={plan} resetLabel={formatReset} />
            ))}
          </section>
        ) : null}
      </main>
    </>
  );
}

/**
 * Narrow unknown fetch payload to quotas.
 *
 * @param value - useListData result
 * @returns Whether value is a quotas response
 */
function isQuotas(value: unknown): value is QuotasResponse {
  if (value === null || typeof value !== 'object') return false;
  return Array.isArray((value as { plans?: unknown }).plans);
}

/**
 * Three-card skeleton while quotas load.
 *
 * @returns Skeleton grid
 */
function HomeGridSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-3" aria-busy="true">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="flex flex-col gap-3 rounded-xl border border-border p-6">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-full" />
        </div>
      ))}
    </div>
  );
}
