import { execFile } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
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

/** A non-percent metric row (sessions, tokens, cost). */
export type QuotaStat = {
  id: string;
  label: string;
  value: string;
};

/** One subscription's quota snapshot. */
export type PlanQuota = {
  id: string;
  name: string;
  plan: string;
  ok: boolean;
  error: string | null;
  source: string;
  usedPercent: number | null;
  headline: string | null;
  stats: QuotaStat[];
  resetsAt: string | null;
  bars: QuotaBar[];
};

/** CLI provider. Optional ones appear only when the binary exists. */
type QuotaProvider = {
  id: string;
  name: string;
  plan: string;
  optional: boolean;
  detect: (home: string) => string | null;
  fetch: (home: string, bin: string | null) => Promise<PlanQuota>;
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
 * Compact token count for a card (1.2K, 4.4M).
 *
 * @param value - Token count
 * @returns Short label
 */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}K`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`;
}

/**
 * True when a path is an executable file.
 *
 * @param path - Absolute path
 * @returns Whether the file is executable
 */
function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * First existing OpenCode binary.
 *
 * @param home - Home directory
 * @returns Absolute path, or null
 */
export function findOpenCodeBin(home = homedir()): string | null {
  const candidates = [
    join(home, '.opencode/bin/opencode'),
    join(home, '.local/bin/opencode'),
    '/opt/homebrew/bin/opencode',
    '/usr/local/bin/opencode',
  ];
  return candidates.find(isExecutable) ?? null;
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
  const minutes = Math.max(1, Math.round(delta / 60_000));
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  if (days > 0 && hours > 0) return `${days}d ${hours}h`;
  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
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
    headline: null,
    stats: [],
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
    headline: null,
    stats: [],
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
 * True when a reset timestamp is still in the future.
 *
 * @param resetsAt - ISO timestamp
 * @param now - Reference time
 * @returns Whether the window is still open
 */
export function isResetPending(resetsAt: string | null, now = Date.now()): boolean {
  if (!resetsAt) return false;
  const ms = Date.parse(resetsAt);
  return Number.isFinite(ms) && ms > now;
}

/**
 * Build Claude bars from five-hour / week utilization objects.
 *
 * @param util - Utilization map
 * @param now - Reference time
 * @returns Active bars only
 */
function claudeBarsFromUtil(util: JsonObject, now = Date.now()): QuotaBar[] {
  const bars: QuotaBar[] = [];
  const session = asObject(util.five_hour);
  const week = asObject(util.seven_day);
  const sessionPct = session ? num(session, 'utilization') : null;
  const sessionReset = session ? str(session, 'resets_at') : null;
  const weekPct = week ? num(week, 'utilization') : null;
  const weekReset = week ? str(week, 'resets_at') : null;
  if (sessionPct !== null && isResetPending(sessionReset, now)) {
    bars.push({
      id: 'session',
      label: 'Session (5h)',
      usedPercent: clampPercent(sessionPct),
      resetsAt: sessionReset,
    });
  }
  if (weekPct !== null && isResetPending(weekReset, now)) {
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
    const reset = str(row, 'resets_at');
    if (!isResetPending(reset, now)) continue;
    const scope = asObject(row.scope);
    const model = asObject(scope?.model);
    const label = str(model ?? {}, 'display_name') ?? 'Scoped';
    const pct = num(row, 'percent');
    if (pct === null) continue;
    bars.push({
      id: `scoped-${label.toLowerCase()}`,
      label,
      usedPercent: clampPercent(pct),
      resetsAt: reset,
    });
  }
  return bars;
}

/**
 * Parse Claude Code `~/.claude.json` usage cache.
 *
 * `/usage` in the TUI does not write this cache. Drop windows whose reset
 * already passed so we never show a finished period as current.
 *
 * @param raw - File JSON
 * @param now - Reference time
 * @returns Plan quota
 */
export function parseClaudeCache(raw: unknown, now = Date.now()): PlanQuota {
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
    return failPlan(
      'claude',
      'Claude',
      plan,
      'No live Claude usage. Run claude auth login.'
    );
  }
  const bars = claudeBarsFromUtil(util, now);
  if (bars.length === 0) {
    return {
      id: 'claude',
      name: 'Claude',
      plan,
      ok: true,
      error: 'Cached windows already reset. Live fetch needs claude auth login.',
      source: 'Claude Code ~/.claude.json',
      usedPercent: null,
      headline: null,
      stats: [],
      resetsAt: null,
      bars: [],
    };
  }
  const week = bars.find((b) => b.id === 'week');
  return {
    id: 'claude',
    name: 'Claude',
    plan,
    ok: true,
    error: null,
    source: 'Claude Code ~/.claude.json',
    usedPercent: week?.usedPercent ?? bars[0]?.usedPercent ?? null,
    headline: null,
    stats: [],
    resetsAt: week?.resetsAt ?? bars[0]?.resetsAt ?? null,
    bars,
  };
}

/**
 * Parse GET /api/oauth/usage JSON.
 *
 * @param raw - API body
 * @param plan - Plan label
 * @param now - Reference time
 * @returns Plan quota
 */
export function parseClaudeOauthUsage(
  raw: unknown,
  plan: string,
  now = Date.now()
): PlanQuota {
  const util = asObject(raw);
  if (!util) {
    return failPlan('claude', 'Claude', plan, 'Claude oauth usage JSON missing');
  }
  const bars = claudeBarsFromUtil(util, now);
  const week = bars.find((b) => b.id === 'week');
  return {
    id: 'claude',
    name: 'Claude',
    plan,
    ok: bars.length > 0,
    error: bars.length === 0 ? 'Claude oauth usage had no open windows.' : null,
    source: 'claude oauth /api/oauth/usage',
    usedPercent: week?.usedPercent ?? bars[0]?.usedPercent ?? null,
    headline: null,
    stats: [],
    resetsAt: week?.resetsAt ?? bars[0]?.resetsAt ?? null,
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
    headline: null,
    stats: [],
    resetsAt: null,
    bars: [],
  };
}

/**
 * Parse `opencode db` JSON totals.
 *
 * @param raw - Query result (array of one row or a row)
 * @returns Plan quota
 */
export function parseOpenCodeTotals(raw: unknown): PlanQuota {
  const row = Array.isArray(raw) ? asObject(raw[0]) : asObject(raw);
  if (!row) {
    return failPlan('opencode', 'OpenCode', 'CLI', 'opencode db returned no totals');
  }
  const sessions = num(row, 'sessions') ?? 0;
  const cost = num(row, 'cost') ?? 0;
  const input = num(row, 'input') ?? 0;
  const output = num(row, 'output') ?? 0;
  return {
    id: 'opencode',
    name: 'OpenCode',
    plan: 'CLI',
    ok: true,
    error: null,
    source: 'opencode db',
    usedPercent: null,
    headline: `$${cost.toFixed(2)}`,
    stats: [
      { id: 'sessions', label: 'Sessions', value: String(Math.round(sessions)) },
      { id: 'input', label: 'Input', value: formatTokenCount(input) },
      { id: 'output', label: 'Output', value: formatTokenCount(output) },
    ],
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
 * Read a Claude Code OAuth access token from the macOS keychain.
 *
 * @returns Token or null
 */
async function readClaudeOauthToken(): Promise<string | null> {
  const fromEnv = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (fromEnv && fromEnv.length > 20) return fromEnv;
  try {
    const { stdout } = await execFileAsync(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { timeout: 5_000 }
    );
    const cred: unknown = JSON.parse(stdout);
    const oauth = asObject(asObject(cred)?.claudeAiOauth);
    const token = oauth ? str(oauth, 'accessToken') : null;
    return token && token.length > 20 ? token : null;
  } catch {
    return null;
  }
}

/**
 * Fetch Claude Max usage. Prefer live oauth; cache is a fallback only.
 *
 * @param home - Home directory
 * @returns Plan quota
 */
export async function fetchClaudeQuota(home = homedir()): Promise<PlanQuota> {
  const raw = await readFile(join(home, '.claude.json'), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  const cached = parseClaudeCache(parsed);
  const token = await readClaudeOauthToken();
  if (token) {
    const live = await fetchJson('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        Accept: 'application/json',
      },
    });
    return parseClaudeOauthUsage(live, cached.plan);
  }
  return cached;
}

/**
 * Fetch OpenCode all-time session cost/tokens via `opencode db`.
 *
 * @param _home - Unused home dir
 * @param bin - OpenCode binary
 * @returns Plan quota
 */
export async function fetchOpenCodeQuota(
  _home: string,
  bin: string | null
): Promise<PlanQuota> {
  if (!bin) {
    return failPlan('opencode', 'OpenCode', 'CLI', 'opencode binary not found');
  }
  const sql =
    'SELECT COUNT(*) AS sessions, COALESCE(SUM(cost),0) AS cost, COALESCE(SUM(tokens_input),0) AS input, COALESCE(SUM(tokens_output),0) AS output FROM session';
  const { stdout } = await execFileAsync(bin, ['db', '--format', 'json', sql], {
    timeout: FETCH_MS,
    env: process.env,
  });
  return parseOpenCodeTotals(JSON.parse(stdout) as unknown);
}

const PROVIDERS: QuotaProvider[] = [
  {
    id: 'cursor',
    name: 'Cursor',
    plan: 'Ultra',
    optional: false,
    detect: () => 'ok',
    fetch: (home) => fetchCursorQuota(home),
  },
  {
    id: 'grok',
    name: 'Grok',
    plan: 'SuperGrok Heavy',
    optional: false,
    detect: () => 'ok',
    fetch: (home) => fetchGrokQuota(home),
  },
  {
    id: 'claude',
    name: 'Claude',
    plan: 'Max 5x',
    optional: false,
    detect: () => 'ok',
    fetch: (home) => fetchClaudeQuota(home),
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    plan: 'CLI',
    optional: true,
    detect: (home) => findOpenCodeBin(home),
    fetch: (home, bin) => fetchOpenCodeQuota(home, bin),
  },
];

/**
 * Load quotas for every detected CLI.
 *
 * @param home - Home directory
 * @returns Dashboard payload
 */
export async function loadQuotas(home = homedir()): Promise<QuotasResponse> {
  const jobs = PROVIDERS.flatMap((provider) => {
    const bin = provider.detect(home);
    if (!bin && provider.optional) return [];
    return [
      provider.fetch(home, bin).catch((err: unknown) =>
        failPlan(
          provider.id,
          provider.name,
          provider.plan,
          err instanceof Error ? err.message : String(err)
        )
      ),
    ];
  });
  const plans = await Promise.all(jobs);
  return {
    fetchedAt: new Date().toISOString(),
    plans,
  };
}
