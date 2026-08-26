import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const FETCH_MS = 15_000;

/** One usage bar on a plan card. */
export type QuotaBar = {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt: string | null;
};

/** One subscription's quota snapshot. */
export type PlanQuota = {
  id: 'cursor' | 'grok' | 'claude';
  name: string;
  plan: string;
  ok: boolean;
  error: string | null;
  source: string;
  usedPercent: number | null;
  resetsAt: string | null;
  bars: QuotaBar[];
};

/** GET /api/quotas payload. */
export type QuotasResponse = {
  fetchedAt: string;
  plans: PlanQuota[];
};

/**
 * Clamp a percent to 0–100. Non-finite values become 0.
 *
 * @param value - Raw percent
 * @returns Clamped percent
 */
export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/**
 * Format a Grok/Claude rate-limit tier into a short plan label.
 *
 * @param tier - Raw tier string
 * @returns Display plan name
 */
export function planLabelFromTier(tier: string): string {
  const t = tier.toLowerCase();
  if (t.includes('max_20x') || t.includes('max20')) return 'Max 20x';
  if (t.includes('max_5x') || t.includes('max5')) return 'Max 5x';
  if (t.includes('heavy')) return 'SuperGrok Heavy';
  if (t.includes('ultra')) return 'Ultra';
  if (t.includes('plus')) return 'Plus';
  if (t.includes('pro')) return 'Pro';
  return tier;
}

/**
 * Relative reset copy from an ISO or epoch-ms string.
 *
 * @param resetsAt - ISO timestamp or unix-ms string
 * @param now - Reference time
 * @returns Short remaining time, or null
 */
export function formatReset(resetsAt: string | null, now = Date.now()): string | null {
  if (!resetsAt) return null;
  const ms = /^\d+$/.test(resetsAt) ? Number(resetsAt) : Date.parse(resetsAt);
  if (!Number.isFinite(ms)) return null;
  const delta = ms - now;
  if (delta <= 0) return 'now';
  const hours = Math.round(delta / 3_600_000);
  if (hours < 1) return `${Math.max(1, Math.round(delta / 60_000))}m`;
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

type JsonObject = { [key: string]: unknown };

/**
 * Narrow unknown to a plain object.
 *
 * @param value - Unknown JSON
 * @returns Object or null
 */
function asObject(value: unknown): JsonObject | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonObject;
}

/**
 * Read a finite number from a JSON object.
 *
 * @param obj - Object
 * @param key - Key
 * @returns Number or null
 */
function num(obj: JsonObject, key: string): number | null {
  const v = obj[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Read a string from a JSON object.
 *
 * @param obj - Object
 * @param key - Key
 * @returns String or null
 */
function str(obj: JsonObject, key: string): string | null {
  const v = obj[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Parse Grok CLI `GET /v1/billing?format=credits` JSON.
 *
 * @param raw - API body
 * @returns Plan quota
 */
export function parseGrokBilling(raw: unknown): PlanQuota {
  const root = asObject(raw);
  const config = asObject(root?.config);
  if (!config) {
    return failPlan('grok', 'Grok', 'SuperGrok Heavy', 'grok CLI billing JSON missing config');
  }
  const used = num(config, 'creditUsagePercent');
  const period: JsonObject = asObject(config.currentPeriod) ?? {};
  const end = str(period, 'end') ?? str(config, 'billingPeriodEnd');
  const products = Array.isArray(config.productUsage) ? config.productUsage : [];
  const bars: QuotaBar[] = [
    {
      id: 'weekly',
      label: 'Weekly Pool',
      usedPercent: clampPercent(used ?? 0),
      resetsAt: end,
    },
  ];
  for (const item of products) {
    const row = asObject(item);
    if (!row) continue;
    const product = str(row, 'product');
    const pct = num(row, 'usagePercent');
    if (!product || pct === null) continue;
    bars.push({
      id: product.toLowerCase(),
      label: product.replace(/^Grok/, 'Grok '),
      usedPercent: clampPercent(pct),
      resetsAt: end,
    });
  }
  return {
    id: 'grok',
    name: 'Grok',
    plan: 'SuperGrok Heavy',
    ok: true,
    error: null,
    source: 'grok CLI billing',
    usedPercent: clampPercent(used ?? 0),
    resetsAt: end,
    bars,
  };
}

/**
 * Parse Cursor GetCurrentPeriodUsage JSON.
 *
 * @param raw - API body
 * @returns Plan quota
 */
export function parseCursorUsage(raw: unknown): PlanQuota {
  const root = asObject(raw);
  if (!root) {
    return failPlan('cursor', 'Cursor', 'Ultra', 'Cursor usage JSON missing');
  }
  const planUsage = asObject(root.planUsage) ?? {};
  const autoPct = num(planUsage, 'autoPercentUsed') ?? 0;
  const apiPct = num(planUsage, 'apiPercentUsed') ?? 0;
  const totalPct =
    num(planUsage, 'totalPercentUsed') ??
    Math.max(autoPct, apiPct);
  const end = str(root, 'billingCycleEnd');
  return {
    id: 'cursor',
    name: 'Cursor',
    plan: 'Ultra',
    ok: true,
    error: null,
    source: 'Cursor app token',
    usedPercent: clampPercent(totalPct),
    resetsAt: end,
    bars: [
      {
        id: 'models',
        label: 'Cursor Models',
        usedPercent: clampPercent(autoPct),
        resetsAt: end,
      },
      {
        id: 'other',
        label: 'Other Models',
        usedPercent: clampPercent(apiPct),
        resetsAt: end,
      },
    ],
  };
}

/**
 * Parse Claude Code `~/.claude.json` usage cache.
 *
 * @param raw - File JSON
 * @returns Plan quota
 */
export function parseClaudeCache(raw: unknown): PlanQuota {
  const root = asObject(raw);
  if (!root) {
    return failPlan('claude', 'Claude', 'Max 5x', 'Claude Code config missing');
  }
  const account = asObject(root.oauthAccount);
  const tier =
    str(account ?? {}, 'organizationRateLimitTier') ??
    str(account ?? {}, 'userRateLimitTier') ??
    'max';
  const plan = planLabelFromTier(tier);
  const cached = asObject(root.cachedUsageUtilization);
  const util = asObject(cached?.utilization);
  if (!util) {
    return failPlan('claude', 'Claude', plan, 'Claude Code has no cached usage. Run /usage in claude.');
  }
  const session = asObject(util.five_hour);
  const week = asObject(util.seven_day);
  const sessionPct = session ? num(session, 'utilization') : null;
  const weekPct = week ? num(week, 'utilization') : null;
  const sessionReset = session ? str(session, 'resets_at') : null;
  const weekReset = week ? str(week, 'resets_at') : null;
  const bars: QuotaBar[] = [];
  if (sessionPct !== null) {
    bars.push({
      id: 'session',
      label: 'Session (5h)',
      usedPercent: clampPercent(sessionPct),
      resetsAt: sessionReset,
    });
  }
  if (weekPct !== null) {
    bars.push({
      id: 'week',
      label: 'Week',
      usedPercent: clampPercent(weekPct),
      resetsAt: weekReset,
    });
  }
  const limits = Array.isArray(util.limits) ? util.limits : [];
  for (const item of limits) {
    const row = asObject(item);
    if (!row) continue;
    const kind = str(row, 'kind');
    if (kind !== 'weekly_scoped') continue;
    const scope = asObject(row.scope);
    const model = asObject(scope?.model);
    const label = str(model ?? {}, 'display_name') ?? 'Scoped';
    const pct = num(row, 'percent');
    if (pct === null) continue;
    bars.push({
      id: `scoped-${label.toLowerCase()}`,
      label,
      usedPercent: clampPercent(pct),
      resetsAt: str(row, 'resets_at'),
    });
  }
  const fetchedAtMs = cached ? num(cached, 'fetchedAtMs') : null;
  const stale =
    fetchedAtMs !== null && Date.now() - fetchedAtMs > 6 * 3_600_000;
  return {
    id: 'claude',
    name: 'Claude',
    plan,
    ok: true,
    error: stale ? 'Claude Code cache is older than 6h. Run /usage in claude.' : null,
    source: 'Claude Code ~/.claude.json',
    usedPercent: clampPercent(weekPct ?? sessionPct ?? 0),
    resetsAt: weekReset ?? sessionReset,
    bars,
  };
}

/**
 * Failed plan row.
 *
 * @param id - Plan id
 * @param name - Display name
 * @param plan - Plan label
 * @param error - Error text
 * @returns Failed quota
 */
function failPlan(
  id: PlanQuota['id'],
  name: string,
  plan: string,
  error: string
): PlanQuota {
  return {
    id,
    name,
    plan,
    ok: false,
    error,
    source: '',
    usedPercent: null,
    resetsAt: null,
    bars: [],
  };
}

/**
 * Fetch JSON from a URL.
 *
 * @param url - Request URL
 * @param init - Fetch init
 * @returns Parsed JSON
 */
async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    if (!text) return {};
    return JSON.parse(text) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the Grok CLI access token from ~/.grok/auth.json.
 *
 * @param home - Home directory
 * @returns Bearer token
 */
export async function readGrokCliToken(home = homedir()): Promise<string> {
  const raw = await readFile(join(home, '.grok/auth.json'), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  const root = asObject(parsed);
  if (!root) throw new Error('grok auth.json is not an object');
  for (const value of Object.values(root)) {
    const entry = asObject(value);
    if (!entry) continue;
    const token = str(entry, 'key');
    const expires = str(entry, 'expires_at');
    if (!token) continue;
    if (expires && Date.parse(expires) < Date.now()) {
      throw new Error('Grok CLI token expired. Run grok login.');
    }
    return token;
  }
  throw new Error('No Grok CLI token. Run grok login.');
}

/**
 * Read Cursor app accessToken from state.vscdb.
 *
 * @param home - Home directory
 * @returns Bearer token
 */
export function readCursorAppToken(home = homedir()): string {
  const dbPath = join(
    home,
    'Library/Application Support/Cursor/User/globalStorage/state.vscdb'
  );
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db
      .prepare("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'")
      .get() as { value?: unknown } | undefined;
    const value = row?.value;
    if (typeof value === 'string' && value.length > 0) return value;
    if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
    throw new Error('Cursor app has no accessToken');
  } finally {
    db.close();
  }
}

/**
 * Fetch Grok SuperGrok Heavy usage via the Grok CLI billing endpoint.
 *
 * @param home - Home directory
 * @returns Plan quota
 */
export async function fetchGrokQuota(home = homedir()): Promise<PlanQuota> {
  const token = await readGrokCliToken(home);
  const raw = await fetchJson(
    'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'x-xai-token-auth': 'xai-grok-cli',
        Accept: 'application/json',
      },
    }
  );
  return parseGrokBilling(raw);
}

/**
 * Fetch Cursor Ultra usage via the signed-in Cursor app token.
 *
 * @param home - Home directory
 * @returns Plan quota
 */
export async function fetchCursorQuota(home = homedir()): Promise<PlanQuota> {
  const token = readCursorAppToken(home);
  const raw = await fetchJson(
    'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
      },
      body: '{}',
    }
  );
  return parseCursorUsage(raw);
}

/**
 * Fetch Claude Max usage from Claude Code's local cache.
 *
 * @param home - Home directory
 * @returns Plan quota
 */
export async function fetchClaudeQuota(home = homedir()): Promise<PlanQuota> {
  const raw = await readFile(join(home, '.claude.json'), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  const plan = parseClaudeCache(parsed);
  try {
    const { stdout } = await execFileAsync('claude', ['auth', 'status', '--json'], {
      timeout: 8_000,
      env: process.env,
    });
    const status: unknown = JSON.parse(stdout);
    const obj = asObject(status);
    if (obj && obj.loggedIn === false && plan.ok) {
      return {
        ...plan,
        error: plan.error ?? 'claude auth status: not logged in for this process',
      };
    }
  } catch {
    // Cache is enough; CLI status is extra.
  }
  return plan;
}

/**
 * Load all three plan quotas in parallel.
 *
 * @param home - Home directory
 * @returns Dashboard payload
 */
export async function loadQuotas(home = homedir()): Promise<QuotasResponse> {
  const [cursor, grok, claude] = await Promise.all([
    fetchCursorQuota(home).catch((err: unknown) =>
      failPlan('cursor', 'Cursor', 'Ultra', err instanceof Error ? err.message : String(err))
    ),
    fetchGrokQuota(home).catch((err: unknown) =>
      failPlan('grok', 'Grok', 'SuperGrok Heavy', err instanceof Error ? err.message : String(err))
    ),
    fetchClaudeQuota(home).catch((err: unknown) =>
      failPlan('claude', 'Claude', 'Max 5x', err instanceof Error ? err.message : String(err))
    ),
  ]);
  return {
    fetchedAt: new Date().toISOString(),
    plans: [cursor, grok, claude],
  };
}
