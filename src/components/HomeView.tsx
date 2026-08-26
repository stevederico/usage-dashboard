import { useEffect, useState } from 'react';
import Header from '@stevederico/skateboard-ui/Header';
import { useListData } from '@stevederico/skateboard-ui/Utilities';
import { Button } from '@stevederico/skateboard-ui/shadcn/ui/button';
import { Skeleton } from '@stevederico/skateboard-ui/ui/skeleton';
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from '@stevederico/skateboard-ui/shadcn/ui/tabs';
import QuotaCard from './QuotaCard';
import QuotaSimple from './QuotaSimple';
import type { PlanQuota } from './QuotaCard';
import { formatReset } from '../lib/format';
import { readRefreshMs, SETTINGS_EVENT } from '../lib/settings';

const MODE_KEY = 'quota-mode';

/** GET /quotas payload. */
type QuotasResponse = {
  fetchedAt: string;
  plans: PlanQuota[];
};

/**
 * Read the last view mode from localStorage.
 *
 * @returns Simple or advanced
 */
function readMode(): 'simple' | 'advanced' {
  try {
    return localStorage.getItem(MODE_KEY) === 'advanced' ? 'advanced' : 'simple';
  } catch {
    return 'simple';
  }
}

/**
 * Local usage dashboard. Simple is stacked name+value lines. Advanced is cards.
 *
 * @returns Dashboard view
 */
export default function HomeView() {
  const { data, loading, error, refetch } = useListData('/quotas');
  const payload = isQuotas(data) ? data : null;
  const [mode, setMode] = useState<'simple' | 'advanced'>(readMode);
  const [refreshMs, setRefreshMs] = useState(readRefreshMs);

  useEffect(() => {
    const sync = () => setRefreshMs(readRefreshMs());
    window.addEventListener(SETTINGS_EVENT, sync);
    return () => window.removeEventListener(SETTINGS_EVENT, sync);
  }, []);

  useEffect(() => {
    if (refreshMs <= 0) return undefined;
    const id = window.setInterval(() => {
      void refetch();
    }, refreshMs);
    return () => window.clearInterval(id);
  }, [refreshMs, refetch]);

  const handleMode = (value: string) => {
    const next = value === 'advanced' ? 'advanced' : 'simple';
    setMode(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      // Ignore quota / private-mode failures.
    }
  };

  return (
    <>
      <Header title="Usage">
        <Tabs value={mode} onValueChange={handleMode}>
          <TabsList variant="line">
            <TabsTrigger value="simple">Simple</TabsTrigger>
            <TabsTrigger value="advanced">Advanced</TabsTrigger>
          </TabsList>
        </Tabs>
        <Button size="sm" onClick={() => void refetch()} disabled={loading}>
          Refresh
        </Button>
      </Header>
      <main className="flex flex-1 flex-col gap-6 p-4 lg:p-6">
        {loading && !payload ? (
          mode === 'simple' ? <HomeLineSkeleton /> : <HomeGridSkeleton />
        ) : null}
        {error ? (
          <p className="text-copy-md text-destructive">{error}</p>
        ) : null}
        {payload && mode === 'simple' ? (
          <QuotaSimple plans={payload.plans} />
        ) : null}
        {payload && mode === 'advanced' ? (
          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
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
 * Thin stacked lines while simple mode loads.
 *
 * @returns Skeleton list
 */
function HomeLineSkeleton() {
  return (
    <div className="flex max-w-xl flex-col gap-5" aria-busy="true">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-1 w-full" />
        </div>
      ))}
    </div>
  );
}

/**
 * Card grid while advanced mode loads.
 *
 * @returns Skeleton grid
 */
function HomeGridSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-busy="true">
      {Array.from({ length: 4 }).map((_, i) => (
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
