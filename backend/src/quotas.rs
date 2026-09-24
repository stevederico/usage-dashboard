//! Local CLI usage collectors for `GET /api/quotas`.
//!
//! One shot per provider. Claude oauth 429 falls back to `~/.claude.json`
//! instead of retrying — a retry loop is what blanks that card. The UI poll
//! (default one hour, never under five minutes) is the throttle.

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::db::Db;
use crate::httpc;
use crate::json::{self, Json};

/// Outbound call budget. Matches the old Node `FETCH_MS`.
const FETCH_MS: i64 = 15_000;

/// `security` keychain lookup budget.
const KEYCHAIN_MS: u64 = 5_000;

/// Claude oauth tokens shorter than this are ignored.
const MIN_OAUTH_LEN: usize = 21;

/// macOS Cursor DB, then the Linux XDG path. First existing file wins.
const CURSOR_DB_PATHS: [&str; 2] = [
    "Library/Application Support/Cursor/User/globalStorage/state.vscdb",
    ".config/Cursor/User/globalStorage/state.vscdb",
];

const OPENCODE_TOTALS_SQL: &str = "SELECT COUNT(*) AS sessions, COALESCE(SUM(cost),0) AS cost, COALESCE(SUM(tokens_input),0) AS input, COALESCE(SUM(tokens_output),0) AS output FROM session";

const OPENCODE_DAYS_SQL: &str = "SELECT date(time_created/1000,'unixepoch','localtime') AS date, COALESCE(SUM(tokens_input+tokens_output+tokens_cache_read+tokens_cache_write),0) AS tokens FROM session WHERE time_created >= (strftime('%s','now','-7 days') * 1000) GROUP BY date";

const OPENCODE_MODELS_SQL: &str = "SELECT model AS name, COALESCE(SUM(tokens_input+tokens_output+tokens_cache_read+tokens_cache_write),0) AS total FROM session GROUP BY model ORDER BY total DESC LIMIT 4";

#[repr(C)]
struct Tm {
    tm_sec: i32,
    tm_min: i32,
    tm_hour: i32,
    tm_mday: i32,
    tm_mon: i32,
    tm_year: i32,
    tm_wday: i32,
    tm_yday: i32,
    tm_isdst: i32,
    tm_gmtoff: i64,
    tm_zone: *const i8,
}

#[link(name = "c")]
unsafe extern "C" {
    fn gmtime_r(timep: *const i64, result: *mut Tm) -> *mut Tm;
    fn localtime_r(timep: *const i64, result: *mut Tm) -> *mut Tm;
}

#[cfg(test)]
#[link(name = "c")]
unsafe extern "C" {
    fn mktime(tm: *mut Tm) -> i64;
}

#[derive(Clone)]
struct Bar {
    id: String,
    label: String,
    used_percent: f64,
    resets_at: Option<String>,
}

struct Stat {
    id: String,
    label: String,
    value: String,
}

struct Day {
    date: String,
    tokens: f64,
}

struct ModelStat {
    name: String,
    total: f64,
}

struct Plan {
    id: String,
    name: String,
    plan: String,
    ok: bool,
    error: Option<String>,
    source: String,
    used_percent: Option<f64>,
    headline: Option<String>,
    stats: Vec<Stat>,
    resets_at: Option<String>,
    bars: Vec<Bar>,
    recent_days: Option<Vec<Day>>,
    models: Option<Vec<ModelStat>>,
}

/// Home directory from `HOME`.
///
/// # Errors
/// Returns an error when `HOME` is unset or empty. The route turns that into HTTP 500.
pub fn home_dir() -> Result<PathBuf, String> {
    match std::env::var_os("HOME") {
        Some(value) if !value.is_empty() => Ok(PathBuf::from(value)),
        _ => Err("HOME is not set".into()),
    }
}

/// Load every detected plan. OpenCode is omitted when its binary is absent.
///
/// `now_ms` is the clock for reset windows and `fetchedAt`.
pub fn load_quotas(home: &Path, now_ms: i64) -> Json {
    let opencode = find_opencode_bin(home);
    let (cursor, grok, claude, open) = thread::scope(|scope| {
        let cursor = scope.spawn(|| fetch_cursor(home));
        let grok = scope.spawn(|| fetch_grok(home, now_ms));
        let claude = scope.spawn(|| fetch_claude(home, now_ms));
        let open = opencode.map(|bin| scope.spawn(move || fetch_opencode(&bin, now_ms)));
        (
            finish(cursor.join(), "cursor", "Cursor", "Ultra"),
            finish(grok.join(), "grok", "Grok", "SuperGrok Heavy"),
            finish(claude.join(), "claude", "Claude", "Max 5x"),
            open.map(|handle| finish(handle.join(), "opencode", "OpenCode", "CLI")),
        )
    });
    let mut plans = vec![cursor, grok, claude];
    if let Some(plan) = open {
        plans.push(plan);
    }
    json::obj([
        ("fetchedAt", json::s(iso_utc(now_ms))),
        ("plans", Json::Arr(plans.iter().map(plan_json).collect())),
    ])
}

fn finish(result: thread::Result<Result<Plan, String>>, id: &str, name: &str, plan: &str) -> Plan {
    match result {
        Ok(Ok(row)) => row,
        Ok(Err(message)) => fail_plan(id, name, plan, &message),
        Err(_) => fail_plan(id, name, plan, "collector panicked"),
    }
}

fn fail_plan(id: &str, name: &str, plan: &str, error: &str) -> Plan {
    Plan {
        id: id.into(),
        name: name.into(),
        plan: plan.into(),
        ok: false,
        error: Some(error.into()),
        source: String::new(),
        used_percent: None,
        headline: None,
        stats: Vec::new(),
        resets_at: None,
        bars: Vec::new(),
        recent_days: None,
        models: None,
    }
}

fn plan_json(plan: &Plan) -> Json {
    let mut map = BTreeMap::new();
    map.insert(
        "bars".into(),
        Json::Arr(plan.bars.iter().map(bar_json).collect()),
    );
    map.insert("error".into(), opt_str(&plan.error));
    map.insert("headline".into(), opt_str(&plan.headline));
    map.insert("id".into(), json::s(&plan.id));
    if let Some(models) = &plan.models {
        map.insert(
            "models".into(),
            Json::Arr(models.iter().map(model_json).collect()),
        );
    }
    map.insert("name".into(), json::s(&plan.name));
    map.insert("ok".into(), Json::Bool(plan.ok));
    map.insert("plan".into(), json::s(&plan.plan));
    if let Some(days) = &plan.recent_days {
        map.insert(
            "recentDays".into(),
            Json::Arr(days.iter().map(day_json).collect()),
        );
    }
    map.insert("resetsAt".into(), opt_str(&plan.resets_at));
    map.insert("source".into(), json::s(&plan.source));
    map.insert(
        "stats".into(),
        Json::Arr(plan.stats.iter().map(stat_json).collect()),
    );
    map.insert("usedPercent".into(), opt_num(plan.used_percent));
    Json::Obj(map)
}

fn bar_json(bar: &Bar) -> Json {
    json::obj([
        ("id", json::s(&bar.id)),
        ("label", json::s(&bar.label)),
        ("resetsAt", opt_str(&bar.resets_at)),
        ("usedPercent", json::n(bar.used_percent)),
    ])
}

fn stat_json(stat: &Stat) -> Json {
    json::obj([
        ("id", json::s(&stat.id)),
        ("label", json::s(&stat.label)),
        ("value", json::s(&stat.value)),
    ])
}

fn day_json(day: &Day) -> Json {
    json::obj([
        ("date", json::s(&day.date)),
        ("tokens", json::n(day.tokens)),
    ])
}

fn model_json(model: &ModelStat) -> Json {
    json::obj([
        ("name", json::s(&model.name)),
        ("total", json::n(model.total)),
    ])
}

fn opt_str(value: &Option<String>) -> Json {
    match value {
        Some(text) => json::s(text),
        None => Json::Null,
    }
}

fn opt_num(value: Option<f64>) -> Json {
    match value {
        Some(number) => json::n(number),
        None => Json::Null,
    }
}

fn jstr<'a>(value: Option<&'a Json>) -> Option<&'a str> {
    let text = value?.as_str()?;
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn jnum(value: &Json, key: &str) -> Option<f64> {
    let number = value.get(key)?.as_f64()?;
    if number.is_finite() {
        Some(number)
    } else {
        None
    }
}

fn clamp_percent(value: f64) -> f64 {
    if !value.is_finite() {
        return 0.0;
    }
    value.clamp(0.0, 100.0)
}

fn plan_label_from_tier(tier: &str) -> String {
    let lower = tier.to_lowercase();
    if lower.contains("max_20x") || lower.contains("max20") {
        return "Max 20x".into();
    }
    if lower.contains("max_5x") || lower.contains("max5") {
        return "Max 5x".into();
    }
    if lower.contains("heavy") {
        return "SuperGrok Heavy".into();
    }
    if lower.contains("ultra") {
        return "Ultra".into();
    }
    if lower.contains("plus") {
        return "Plus".into();
    }
    if lower.contains("pro") {
        return "Pro".into();
    }
    tier.to_string()
}

/// Short remaining time. `None` when the timestamp is missing or unparseable.
///
/// The page formats resets in the browser. This stays so the port matches the
/// old Node helper under test.
#[allow(dead_code)]
fn format_reset(resets_at: Option<&str>, now_ms: i64) -> Option<String> {
    let ms = parse_instant(resets_at?)?;
    let delta = ms - now_ms;
    if delta <= 0 {
        return Some("now".into());
    }
    let minutes = ((delta as f64) / 60_000.0).round().max(1.0) as i64;
    let days = minutes / 1_440;
    let hours = (minutes % 1_440) / 60;
    if days > 0 && hours > 0 {
        return Some(format!("{days}d {hours}h"));
    }
    if days > 0 {
        return Some(format!("{days}d"));
    }
    if hours > 0 {
        return Some(format!("{hours}h"));
    }
    Some(format!("{minutes}m"))
}

fn format_token_count(value: f64) -> String {
    if !value.is_finite() || value <= 0.0 {
        return "0".into();
    }
    if value < 1_000.0 {
        return format!("{}", value.round() as i64);
    }
    if value < 1_000_000.0 {
        let digits = if value < 10_000.0 { 1 } else { 0 };
        return format!("{}K", js_to_fixed(value / 1_000.0, digits));
    }
    let digits = if value < 10_000_000.0 { 1 } else { 0 };
    format!("{}M", js_to_fixed(value / 1_000_000.0, digits))
}

/// `Number#toFixed` for the magnitudes these cards use (0–2 digits).
fn js_to_fixed(value: f64, digits: u32) -> String {
    let negative = value.is_sign_negative() && value != 0.0;
    let scale = 10f64.powi(digits as i32);
    let scaled = (value.abs() * scale).round() as u128;
    let pow = scale as u128;
    let whole = scaled / pow;
    let frac = scaled % pow;
    let mut out = if negative {
        format!("-{whole}")
    } else {
        format!("{whole}")
    };
    if digits > 0 {
        out.push('.');
        out.push_str(&format!("{frac:0width$}", width = digits as usize));
    }
    out
}

fn friendly_model_name(id: &str) -> String {
    let mut raw = id.to_string();
    if raw.starts_with('{') {
        if let Ok(parsed) = json::parse(raw.as_bytes()) {
            if let Some(nested) = jstr(parsed.get("id")) {
                raw = nested.to_string();
            }
        }
    }
    let stripped = raw.strip_prefix("claude-").unwrap_or(&raw);
    strip_date_suffix(stripped).replace('-', " ")
}

fn strip_date_suffix(value: &str) -> &str {
    let bytes = value.as_bytes();
    if bytes.len() > 9
        && bytes[bytes.len() - 9] == b'-'
        && bytes[bytes.len() - 8..].iter().all(u8::is_ascii_digit)
    {
        return &value[..bytes.len() - 9];
    }
    value
}

fn is_reset_pending(resets_at: Option<&str>, now_ms: i64) -> bool {
    let Some(text) = resets_at else {
        return true;
    };
    match parse_instant(text) {
        Some(ms) => ms > now_ms,
        None => true,
    }
}

fn parse_grok_billing(raw: &Json) -> Plan {
    let Some(config) = raw.get("config").filter(|value| value.as_obj().is_some()) else {
        return fail_plan(
            "grok",
            "Grok",
            "SuperGrok Heavy",
            "grok CLI billing JSON missing config",
        );
    };
    let used = jnum(config, "creditUsagePercent");
    let end = config
        .get("currentPeriod")
        .and_then(|period| jstr(period.get("end")))
        .or_else(|| jstr(config.get("billingPeriodEnd")))
        .map(str::to_string);
    let mut bars = vec![Bar {
        id: "weekly".into(),
        label: "Weekly Pool".into(),
        used_percent: clamp_percent(used.unwrap_or(0.0)),
        resets_at: end.clone(),
    }];
    if let Some(products) = config.get("productUsage").and_then(Json::as_arr) {
        push_grok_products(&mut bars, products, end.clone());
    }
    let mut plan = ok_plan("grok", "Grok", "SuperGrok Heavy", "grok CLI billing", bars);
    plan.used_percent = Some(clamp_percent(used.unwrap_or(0.0)));
    plan.resets_at = end;
    plan
}

fn push_grok_products(bars: &mut Vec<Bar>, products: &[Json], end: Option<String>) {
    for item in products {
        let Some(product) = jstr(item.get("product")) else {
            continue;
        };
        let Some(percent) = jnum(item, "usagePercent") else {
            continue;
        };
        bars.push(Bar {
            id: product.to_lowercase(),
            label: grok_product_label(product),
            used_percent: clamp_percent(percent),
            resets_at: end.clone(),
        });
    }
}

fn grok_product_label(product: &str) -> String {
    match product.strip_prefix("Grok") {
        Some(rest) => format!("Grok {rest}"),
        None => product.to_string(),
    }
}

fn parse_cursor_usage(raw: &Json) -> Plan {
    if raw.as_obj().is_none() {
        return fail_plan("cursor", "Cursor", "Ultra", "Cursor usage JSON missing");
    }
    let plan_usage = raw.get("planUsage").unwrap_or(&Json::Null);
    let auto = jnum(plan_usage, "autoPercentUsed").unwrap_or(0.0);
    let api = jnum(plan_usage, "apiPercentUsed").unwrap_or(0.0);
    let total = jnum(plan_usage, "totalPercentUsed").unwrap_or(auto.max(api));
    let end = jstr(raw.get("billingCycleEnd")).map(str::to_string);
    let bars = vec![
        Bar {
            id: "models".into(),
            label: "Cursor Models".into(),
            used_percent: clamp_percent(auto),
            resets_at: end.clone(),
        },
        Bar {
            id: "other".into(),
            label: "Other Models".into(),
            used_percent: clamp_percent(api),
            resets_at: end.clone(),
        },
    ];
    let mut plan = ok_plan("cursor", "Cursor", "Ultra", "Cursor app token", bars);
    plan.used_percent = Some(clamp_percent(total));
    plan.resets_at = end;
    plan
}

fn ok_plan(id: &str, name: &str, plan: &str, source: &str, bars: Vec<Bar>) -> Plan {
    Plan {
        id: id.into(),
        name: name.into(),
        plan: plan.into(),
        ok: true,
        error: None,
        source: source.into(),
        used_percent: None,
        headline: None,
        stats: Vec::new(),
        resets_at: None,
        bars,
        recent_days: None,
        models: None,
    }
}

fn parse_claude_cache(raw: &Json, now_ms: i64) -> Plan {
    if raw.as_obj().is_none() {
        return fail_plan("claude", "Claude", "Max 5x", "Claude Code config missing");
    }
    let account = raw.get("oauthAccount").unwrap_or(&Json::Null);
    let tier = jstr(account.get("organizationRateLimitTier"))
        .or_else(|| jstr(account.get("userRateLimitTier")))
        .unwrap_or("max");
    let plan_name = plan_label_from_tier(tier);
    let Some(util) = raw
        .get("cachedUsageUtilization")
        .and_then(|cached| cached.get("utilization"))
        .filter(|value| value.as_obj().is_some())
    else {
        return fail_plan(
            "claude",
            "Claude",
            &plan_name,
            "No live Claude usage. Run claude auth login.",
        );
    };
    claude_plan_from_bars(
        &plan_name,
        &claude_bars(util, now_ms),
        "Claude Code ~/.claude.json",
        true,
    )
}

fn parse_claude_oauth(raw: &Json, plan_name: &str, now_ms: i64) -> Plan {
    if raw.as_obj().is_none() {
        return fail_plan(
            "claude",
            "Claude",
            plan_name,
            "Claude oauth usage JSON missing",
        );
    }
    claude_plan_from_bars(
        plan_name,
        &claude_bars(raw, now_ms),
        "claude oauth /api/oauth/usage",
        false,
    )
}

fn claude_plan_from_bars(plan_name: &str, bars: &[Bar], source: &str, cache: bool) -> Plan {
    if bars.is_empty() {
        let error = if cache {
            "Cached windows already reset. Live fetch needs claude auth login."
        } else {
            "Claude oauth usage had no open windows."
        };
        return Plan {
            id: "claude".into(),
            name: "Claude".into(),
            plan: plan_name.into(),
            ok: cache,
            error: Some(error.into()),
            source: source.into(),
            used_percent: None,
            headline: None,
            stats: Vec::new(),
            resets_at: None,
            bars: Vec::new(),
            recent_days: None,
            models: None,
        };
    }
    let chosen = bars
        .iter()
        .find(|bar| bar.id == "week")
        .or_else(|| bars.first());
    Plan {
        id: "claude".into(),
        name: "Claude".into(),
        plan: plan_name.into(),
        ok: true,
        error: None,
        source: source.into(),
        used_percent: chosen.map(|bar| bar.used_percent),
        headline: None,
        stats: Vec::new(),
        resets_at: chosen.and_then(|bar| bar.resets_at.clone()),
        bars: bars.to_vec(),
        recent_days: None,
        models: None,
    }
}

fn claude_bars(util: &Json, now_ms: i64) -> Vec<Bar> {
    let mut bars = Vec::new();
    push_claude_window(
        &mut bars,
        util.get("five_hour"),
        "session",
        "Session (5h)",
        now_ms,
    );
    push_claude_window(&mut bars, util.get("seven_day"), "week", "Week", now_ms);
    push_scoped_limits(&mut bars, util.get("limits").and_then(Json::as_arr), now_ms);
    bars
}

fn push_claude_window(
    bars: &mut Vec<Bar>,
    node: Option<&Json>,
    id: &str,
    label: &str,
    now_ms: i64,
) {
    let Some(node) = node else {
        return;
    };
    let Some(percent) = jnum(node, "utilization") else {
        return;
    };
    let reset = jstr(node.get("resets_at")).map(str::to_string);
    if !is_reset_pending(reset.as_deref(), now_ms) {
        return;
    }
    bars.push(Bar {
        id: id.into(),
        label: label.into(),
        used_percent: clamp_percent(percent),
        resets_at: reset,
    });
}

fn push_scoped_limits(bars: &mut Vec<Bar>, limits: Option<&[Json]>, now_ms: i64) {
    let Some(limits) = limits else {
        return;
    };
    for item in limits {
        if jstr(item.get("kind")) != Some("weekly_scoped") {
            continue;
        }
        let reset = jstr(item.get("resets_at")).map(str::to_string);
        if !is_reset_pending(reset.as_deref(), now_ms) {
            continue;
        }
        let label = item
            .get("scope")
            .and_then(|scope| scope.get("model"))
            .and_then(|model| jstr(model.get("display_name")))
            .unwrap_or("Scoped");
        let Some(percent) = jnum(item, "percent") else {
            continue;
        };
        bars.push(Bar {
            id: format!("scoped-{}", label.to_lowercase()),
            label: label.into(),
            used_percent: clamp_percent(percent),
            resets_at: reset,
        });
    }
}

fn parse_claude_stats(raw: &Json, now_ms: i64) -> (Vec<Day>, Vec<ModelStat>) {
    let mut by_date = BTreeMap::new();
    if let Some(rows) = raw.get("dailyModelTokens").and_then(Json::as_arr) {
        for item in rows {
            let Some(date) = jstr(item.get("date")) else {
                continue;
            };
            let Some(by_model) = item.get("tokensByModel").and_then(Json::as_obj) else {
                continue;
            };
            let total: f64 = by_model
                .values()
                .filter_map(|value| value.as_f64())
                .filter(|value| value.is_finite())
                .sum();
            by_date.insert(date.to_string(), total);
        }
    }
    let recent_days = last_seven_dates(now_ms)
        .into_iter()
        .map(|date| Day {
            tokens: by_date.get(&date).copied().unwrap_or(0.0),
            date,
        })
        .collect();
    let mut models = Vec::new();
    if let Some(usage) = raw.get("modelUsage").and_then(Json::as_obj) {
        for (id, value) in usage {
            let input = jnum(value, "inputTokens").unwrap_or(0.0);
            let output = jnum(value, "outputTokens").unwrap_or(0.0);
            let cache_read = jnum(value, "cacheReadInputTokens").unwrap_or(0.0);
            let cache_write = jnum(value, "cacheCreationInputTokens").unwrap_or(0.0);
            models.push(ModelStat {
                name: friendly_model_name(id),
                total: input + output + cache_read + cache_write,
            });
        }
    }
    models.sort_by(|left, right| right.total.total_cmp(&left.total));
    models.truncate(4);
    (recent_days, models)
}

fn parse_opencode_totals(raw: &Json) -> Plan {
    let row = raw.as_arr().and_then(|rows| rows.first()).unwrap_or(raw);
    if row.as_obj().is_none() {
        return fail_plan(
            "opencode",
            "OpenCode",
            "CLI",
            "opencode db returned no totals",
        );
    }
    let sessions = jnum(row, "sessions").unwrap_or(0.0);
    let cost = jnum(row, "cost").unwrap_or(0.0);
    let input = jnum(row, "input").unwrap_or(0.0);
    let output = jnum(row, "output").unwrap_or(0.0);
    let mut plan = ok_plan("opencode", "OpenCode", "CLI", "opencode db", Vec::new());
    plan.headline = Some(format!("${}", js_to_fixed(cost, 2)));
    plan.stats = vec![
        Stat {
            id: "sessions".into(),
            label: "Sessions".into(),
            value: format!("{}", sessions.round() as i64),
        },
        Stat {
            id: "input".into(),
            label: "Input".into(),
            value: format_token_count(input),
        },
        Stat {
            id: "output".into(),
            label: "Output".into(),
            value: format_token_count(output),
        },
    ];
    plan
}

fn fetch_cursor(home: &Path) -> Result<Plan, String> {
    let token = read_cursor_token(home)?;
    let auth = format!("Bearer {token}");
    let headers = [
        ("Authorization", auth.as_str()),
        ("Connect-Protocol-Version", "1"),
    ];
    let raw = http_json(
        "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
        &headers,
        Some("{}"),
    )?;
    Ok(parse_cursor_usage(&raw))
}

fn fetch_grok(home: &Path, now_ms: i64) -> Result<Plan, String> {
    let token = read_grok_token(home, now_ms)?;
    let auth = format!("Bearer {token}");
    let headers = [
        ("Authorization", auth.as_str()),
        ("x-xai-token-auth", "xai-grok-cli"),
        ("Accept", "application/json"),
    ];
    let raw = http_json(
        "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
        &headers,
        None,
    )?;
    Ok(parse_grok_billing(&raw))
}

fn fetch_claude(home: &Path, now_ms: i64) -> Result<Plan, String> {
    let raw = fs::read_to_string(home.join(".claude.json")).map_err(|err| err.to_string())?;
    let parsed = json::parse(raw.as_bytes()).map_err(|err| err.to_string())?;
    let cached = parse_claude_cache(&parsed, now_ms);
    if let Some(token) = read_claude_token() {
        let auth = format!("Bearer {token}");
        let headers = [
            ("Authorization", auth.as_str()),
            ("anthropic-beta", "oauth-2025-04-20"),
            ("Accept", "application/json"),
        ];
        if let Ok(live) = http_json("https://api.anthropic.com/api/oauth/usage", &headers, None) {
            let plan = parse_claude_oauth(&live, &cached.plan, now_ms);
            return Ok(attach_claude_stats(plan, home, now_ms));
        }
    }
    Ok(attach_claude_stats(cached, home, now_ms))
}

fn attach_claude_stats(mut plan: Plan, home: &Path, now_ms: i64) -> Plan {
    let Ok(raw) = fs::read_to_string(home.join(".claude/stats-cache.json")) else {
        return plan;
    };
    let Ok(parsed) = json::parse(raw.as_bytes()) else {
        return plan;
    };
    let (days, models) = parse_claude_stats(&parsed, now_ms);
    plan.recent_days = Some(days);
    plan.models = Some(models);
    plan
}

fn fetch_opencode(bin: &Path, now_ms: i64) -> Result<Plan, String> {
    let stdout = run_timeout(
        bin,
        &["db", "--format", "json", OPENCODE_TOTALS_SQL],
        FETCH_MS as u64,
    )?;
    let raw = json::parse(stdout.trim().as_bytes()).map_err(|err| err.to_string())?;
    let mut plan = parse_opencode_totals(&raw);
    let (days, models) = opencode_breakdown(bin, now_ms)?;
    plan.recent_days = Some(days);
    plan.models = Some(models);
    Ok(plan)
}

fn opencode_breakdown(bin: &Path, now_ms: i64) -> Result<(Vec<Day>, Vec<ModelStat>), String> {
    let days_out = run_timeout(
        bin,
        &["db", "--format", "json", OPENCODE_DAYS_SQL],
        FETCH_MS as u64,
    )?;
    let models_out = run_timeout(
        bin,
        &["db", "--format", "json", OPENCODE_MODELS_SQL],
        FETCH_MS as u64,
    )?;
    let day_raw = json::parse(days_out.trim().as_bytes()).map_err(|err| err.to_string())?;
    let model_raw = json::parse(models_out.trim().as_bytes()).map_err(|err| err.to_string())?;
    Ok((opencode_days(&day_raw, now_ms), opencode_models(&model_raw)))
}

fn opencode_days(raw: &Json, now_ms: i64) -> Vec<Day> {
    let mut by_date = BTreeMap::new();
    if let Some(rows) = raw.as_arr() {
        for item in rows {
            let Some(date) = jstr(item.get("date")) else {
                continue;
            };
            let Some(tokens) = jnum(item, "tokens") else {
                continue;
            };
            by_date.insert(date.to_string(), tokens);
        }
    }
    last_seven_dates(now_ms)
        .into_iter()
        .map(|date| Day {
            tokens: by_date.get(&date).copied().unwrap_or(0.0),
            date,
        })
        .collect()
}

fn opencode_models(raw: &Json) -> Vec<ModelStat> {
    let mut models = Vec::new();
    let Some(rows) = raw.as_arr() else {
        return models;
    };
    for item in rows {
        let Some(name) = jstr(item.get("name")) else {
            continue;
        };
        let Some(total) = jnum(item, "total") else {
            continue;
        };
        models.push(ModelStat {
            name: friendly_model_name(name),
            total,
        });
    }
    models
}

fn find_opencode_bin(home: &Path) -> Option<PathBuf> {
    let candidates = [
        home.join(".opencode/bin/opencode"),
        home.join(".local/bin/opencode"),
        PathBuf::from("/opt/homebrew/bin/opencode"),
        PathBuf::from("/usr/local/bin/opencode"),
    ];
    candidates.into_iter().find(|path| is_executable(path))
}

fn is_executable(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return meta.permissions().mode() & 0o111 != 0;
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn read_grok_token(home: &Path, now_ms: i64) -> Result<String, String> {
    let raw = fs::read_to_string(home.join(".grok/auth.json")).map_err(|err| err.to_string())?;
    let parsed =
        json::parse(raw.as_bytes()).map_err(|_| "grok auth.json is not an object".to_string())?;
    let root = parsed.as_obj().ok_or("grok auth.json is not an object")?;
    for value in root.values() {
        let Some(token) = jstr(value.get("key")) else {
            continue;
        };
        if let Some(expires) = jstr(value.get("expires_at")) {
            if let Some(ms) = parse_instant(expires) {
                if ms < now_ms {
                    return Err("Grok CLI token expired. Run grok login.".into());
                }
            }
        }
        return Ok(token.to_string());
    }
    Err("No Grok CLI token. Run grok login.".into())
}

fn read_cursor_token(home: &Path) -> Result<String, String> {
    for relative in CURSOR_DB_PATHS {
        let path = home.join(relative);
        if path.is_file() {
            return read_cursor_db(&path);
        }
    }
    Err("Cursor app has no accessToken".into())
}

fn read_cursor_db(path: &Path) -> Result<String, String> {
    let path_str = path.to_str().ok_or("Cursor database path is not UTF-8")?;
    let db = Db::open_readonly(path_str).map_err(|err| err.to_string())?;
    let rows = db
        .query(
            "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'",
            &[],
        )
        .map_err(|err| err.to_string())?;
    let Some(token) = rows.first().and_then(|row| row.text("value")) else {
        return Err("Cursor app has no accessToken".into());
    };
    if token.is_empty() {
        return Err("Cursor app has no accessToken".into());
    }
    Ok(token.to_string())
}

fn read_claude_token() -> Option<String> {
    if let Some(token) = std::env::var("CLAUDE_CODE_OAUTH_TOKEN").ok() {
        if token.len() >= MIN_OAUTH_LEN {
            return Some(token);
        }
    }
    let stdout = run_timeout(
        Path::new("security"),
        &[
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-w",
        ],
        KEYCHAIN_MS,
    )
    .ok()?;
    let parsed = json::parse(stdout.trim().as_bytes()).ok()?;
    let token = jstr(
        parsed
            .get("claudeAiOauth")
            .and_then(|oauth| oauth.get("accessToken")),
    )?;
    if token.len() >= MIN_OAUTH_LEN {
        Some(token.to_string())
    } else {
        None
    }
}

/// One blocking request. HTTP error statuses are errors; the body is not included.
fn http_json(url: &str, headers: &[(&str, &str)], body: Option<&str>) -> Result<Json, String> {
    let response = match body {
        Some(payload) => httpc::post_json(url, headers, payload, FETCH_MS),
        None => httpc::get(url, headers, FETCH_MS),
    }
    .map_err(|err| err.to_string())?;
    if !response.ok() {
        return Err(format!("HTTP {}", response.status));
    }
    let text = response.text();
    if text.is_empty() {
        return Ok(json::obj([]));
    }
    json::parse(text.as_bytes()).map_err(|err| err.to_string())
}

fn run_timeout(bin: &Path, args: &[&str], timeout_ms: u64) -> Result<String, String> {
    let mut child = Command::new(bin)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| err.to_string())?;
    let mut stdout = child.stdout.take().ok_or("missing stdout")?;
    let mut stderr = child.stderr.take().ok_or("missing stderr")?;
    let out_handle = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let err_handle = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf);
        buf
    });
    let status = wait_child(&mut child, timeout_ms)?;
    let out = String::from_utf8_lossy(&out_handle.join().unwrap_or_default()).into_owned();
    let err = String::from_utf8_lossy(&err_handle.join().unwrap_or_default()).into_owned();
    if !status.success() {
        let message = err.trim();
        if message.is_empty() {
            return Err(format!("exit {}", status.code().unwrap_or(-1)));
        }
        return Err(message.to_string());
    }
    Ok(out)
}

fn wait_child(
    child: &mut std::process::Child,
    timeout_ms: u64,
) -> Result<std::process::ExitStatus, String> {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("command timed out".into());
            }
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(err) => return Err(err.to_string()),
        }
    }
}

fn zero_tm() -> Tm {
    Tm {
        tm_sec: 0,
        tm_min: 0,
        tm_hour: 0,
        tm_mday: 0,
        tm_mon: 0,
        tm_year: 0,
        tm_wday: 0,
        tm_yday: 0,
        tm_isdst: 0,
        tm_gmtoff: 0,
        tm_zone: std::ptr::null(),
    }
}

fn iso_utc(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000) as u32;
    let mut tm = zero_tm();
    // SAFETY: `secs` is a live i64 and `tm` is a writable `struct tm` for the call.
    let ok = unsafe { gmtime_r(&secs, &mut tm) };
    if ok.is_null() {
        return "1970-01-01T00:00:00.000Z".into();
    }
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_hour,
        tm.tm_min,
        tm.tm_sec,
        millis
    )
}

fn local_ymd(ms: i64) -> (i32, i32, i32) {
    let secs = ms.div_euclid(1000);
    let mut tm = zero_tm();
    // SAFETY: `secs` is a live i64 and `tm` is a writable `struct tm` for the call.
    let ok = unsafe { localtime_r(&secs, &mut tm) };
    if ok.is_null() {
        return (1970, 1, 1);
    }
    (tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday)
}

fn last_seven_dates(now_ms: i64) -> Vec<String> {
    let (year, month, day) = local_ymd(now_ms);
    (0..7)
        .map(|index| {
            let (y, m, d) = sub_days(year, month, day, 6 - index);
            format!("{y:04}-{m:02}-{d:02}")
        })
        .collect()
}

fn sub_days(mut year: i32, mut month: i32, mut day: i32, days: i32) -> (i32, i32, i32) {
    for _ in 0..days {
        day -= 1;
        if day < 1 {
            month -= 1;
            if month < 1 {
                month = 12;
                year -= 1;
            }
            day = days_in_month(year, month);
        }
    }
    (year, month, day)
}

fn days_in_month(year: i32, month: i32) -> i32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap(year) => 29,
        2 => 28,
        _ => 30,
    }
}

fn is_leap(year: i32) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

/// Parse an ISO-8601 instant or an all-digit epoch-ms string.
///
/// Fractional seconds keep the first three digits, matching `Date.parse`.
fn parse_instant(text: &str) -> Option<i64> {
    if !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()) {
        return text.parse().ok();
    }
    let bytes = text.as_bytes();
    if bytes.len() < 20 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return None;
    }
    if bytes[13] != b':' || bytes[16] != b':' {
        return None;
    }
    let year: i32 = text[0..4].parse().ok()?;
    let month: i32 = text[5..7].parse().ok()?;
    let day: i32 = text[8..10].parse().ok()?;
    let hour: i32 = text[11..13].parse().ok()?;
    let minute: i32 = text[14..16].parse().ok()?;
    let second: i32 = text[17..19].parse().ok()?;
    let (millis, rest) = parse_fraction_and_rest(text, 19)?;
    let offset_min = parse_offset(rest)?;
    let days = civil_days(year, month, day)?;
    let utc_secs =
        days * 86_400 + i64::from(hour) * 3_600 + i64::from(minute) * 60 + i64::from(second)
            - offset_min * 60;
    Some(utc_secs * 1_000 + millis)
}

fn parse_fraction_and_rest(text: &str, mut index: usize) -> Option<(i64, &str)> {
    let bytes = text.as_bytes();
    let mut millis = 0_i64;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        let frac = &text[start..index];
        if frac.is_empty() {
            return None;
        }
        let mut padded = frac.to_string();
        if padded.len() > 3 {
            padded.truncate(3);
        }
        while padded.len() < 3 {
            padded.push('0');
        }
        millis = padded.parse().ok()?;
    }
    Some((millis, &text[index..]))
}

fn parse_offset(rest: &str) -> Option<i64> {
    if rest == "Z" || rest == "z" {
        return Some(0);
    }
    let bytes = rest.as_bytes();
    if bytes.len() != 6 || (bytes[0] != b'+' && bytes[0] != b'-') || bytes[3] != b':' {
        return None;
    }
    let sign = if bytes[0] == b'+' { 1 } else { -1 };
    let hours: i64 = rest[1..3].parse().ok()?;
    let minutes: i64 = rest[4..6].parse().ok()?;
    Some(sign * (hours * 60 + minutes))
}

fn civil_days(year: i32, month: i32, day: i32) -> Option<i64> {
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return None;
    }
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = i64::from(y - era * 400);
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + i64::from(doy);
    Some(i64::from(era) * 146_097 + doe - 719_468)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Json {
        json::parse(text.as_bytes()).unwrap()
    }

    #[test]
    fn clamp_percent_caps_and_rejects_nan() {
        assert_eq!(clamp_percent(140.0), 100.0);
        assert_eq!(clamp_percent(f64::NAN), 0.0);
    }

    #[test]
    fn plan_label_maps_claude_5x() {
        assert_eq!(plan_label_from_tier("default_claude_max_5x"), "Max 5x");
    }

    #[test]
    fn format_reset_matches_node_cases() {
        let now = parse_instant("2026-08-26T12:00:00Z").unwrap();
        assert_eq!(now, 1_787_745_600_000);
        assert_eq!(
            format_reset(Some("2026-08-27T12:00:00Z"), now).as_deref(),
            Some("1d")
        );
        assert_eq!(
            format_reset(Some("2026-08-28T17:00:00Z"), now).as_deref(),
            Some("2d 5h")
        );
    }

    #[test]
    fn parse_instant_keeps_three_fraction_digits() {
        assert_eq!(
            parse_instant("2026-08-20T19:20:27.042381+00:00"),
            Some(1_787_253_627_042)
        );
    }

    #[test]
    fn parse_grok_billing_reads_weekly_and_products() {
        let plan = parse_grok_billing(&parse(
            r#"{"config":{"currentPeriod":{"end":"2026-08-27T19:20:27.042381+00:00"},"creditUsagePercent":84,"productUsage":[{"product":"GrokBuild","usagePercent":69},{"product":"GrokChat","usagePercent":10}]}}"#,
        ));
        assert!(plan.ok);
        assert_eq!(plan.used_percent, Some(84.0));
        assert_eq!(plan.bars[0].label, "Weekly Pool");
        assert_eq!(plan.bars[1].label, "Grok Build");
        assert_eq!(plan.bars[1].used_percent, 69.0);
    }

    #[test]
    fn parse_cursor_usage_maps_auto_and_api() {
        let plan = parse_cursor_usage(&parse(
            r#"{"billingCycleEnd":"1787947174893","planUsage":{"autoPercentUsed":12.5,"apiPercentUsed":3,"totalPercentUsed":12.5}}"#,
        ));
        assert!(plan.ok);
        assert_eq!(plan.used_percent, Some(12.5));
        assert_eq!(plan.bars[0].label, "Cursor Models");
        assert_eq!(plan.bars[1].used_percent, 3.0);
    }

    #[test]
    fn format_token_count_formats_millions() {
        assert_eq!(format_token_count(4_373_448.0), "4.4M");
    }

    #[test]
    fn parse_opencode_totals_reads_cost() {
        let plan = parse_opencode_totals(&parse(
            r#"[{"sessions":25,"cost":0.63,"input":4373448,"output":151216}]"#,
        ));
        assert!(plan.ok);
        assert_eq!(plan.headline.as_deref(), Some("$0.63"));
        assert_eq!(plan.stats[0].value, "25");
        assert_eq!(plan.stats[1].value, "4.4M");
    }

    #[test]
    fn parse_claude_cache_reads_open_windows() {
        let now = parse_instant("2026-08-26T19:00:00Z").unwrap();
        let plan = parse_claude_cache(
            &parse(
                r#"{"oauthAccount":{"organizationRateLimitTier":"default_claude_max_5x"},"cachedUsageUtilization":{"utilization":{"five_hour":{"utilization":39,"resets_at":"2026-08-26T22:00:00Z"},"seven_day":{"utilization":49,"resets_at":"2026-08-31T00:00:00Z"},"limits":[{"kind":"weekly_scoped","percent":66,"resets_at":"2026-08-31T00:00:00Z","scope":{"model":{"display_name":"Fable"}}}]}}}"#,
            ),
            now,
        );
        assert!(plan.ok);
        assert_eq!(plan.plan, "Max 5x");
        assert_eq!(plan.used_percent, Some(49.0));
        assert_eq!(plan.bars.len(), 3);
        assert_eq!(plan.bars[2].label, "Fable");
        assert!(plan.error.is_none());
    }

    #[test]
    fn parse_claude_cache_drops_finished_windows() {
        let now = parse_instant("2026-08-26T19:00:00Z").unwrap();
        let plan = parse_claude_cache(
            &parse(
                r#"{"oauthAccount":{"organizationRateLimitTier":"default_claude_max_5x"},"cachedUsageUtilization":{"utilization":{"five_hour":{"utilization":39,"resets_at":"2026-08-20T06:29:59Z"},"seven_day":{"utilization":49,"resets_at":"2026-08-24T00:59:59Z"}}}}"#,
            ),
            now,
        );
        assert!(plan.bars.is_empty());
        assert!(plan.used_percent.is_none());
        let error = plan.error.unwrap_or_default();
        assert!(error.to_lowercase().contains("login"));
        assert!(!error.contains("/usage"));
    }

    #[test]
    fn parse_claude_cache_keeps_zero_when_reset_missing() {
        let plan = parse_claude_cache(
            &parse(
                r#"{"oauthAccount":{"organizationRateLimitTier":"default_claude_max_5x"},"cachedUsageUtilization":{"utilization":{"five_hour":{"utilization":0,"resets_at":null},"seven_day":{"utilization":0,"resets_at":null}}}}"#,
            ),
            0,
        );
        assert!(plan.ok);
        assert_eq!(plan.used_percent, Some(0.0));
        assert_eq!(plan.bars.len(), 2);
        assert!(plan.error.is_none());
    }

    #[test]
    fn parse_claude_stats_fills_seven_days_and_models() {
        let now = local_epoch_ms(2026, 8, 26, 15);
        let (days, models) = parse_claude_stats(
            &parse(
                r#"{"dailyModelTokens":[{"date":"2026-08-26","tokensByModel":{"claude-opus-4-8":1000}}],"modelUsage":{"claude-opus-4-8":{"inputTokens":100,"outputTokens":50,"cacheReadInputTokens":10,"cacheCreationInputTokens":5}}}"#,
            ),
            now,
        );
        assert_eq!(days.len(), 7);
        assert_eq!(days[6].date, "2026-08-26");
        assert_eq!(models[0].name, "opus 4 8");
        assert_eq!(models[0].total, 165.0);
    }

    #[test]
    fn parse_claude_oauth_maps_live_windows() {
        let now = parse_instant("2026-08-26T19:00:00Z").unwrap();
        let plan = parse_claude_oauth(
            &parse(
                r#"{"five_hour":{"utilization":12,"resets_at":"2026-08-26T22:00:00Z"},"seven_day":{"utilization":40,"resets_at":"2026-08-31T00:00:00Z"}}"#,
            ),
            "Max 5x",
            now,
        );
        assert!(plan.ok);
        assert_eq!(plan.used_percent, Some(40.0));
        assert_eq!(plan.source, "claude oauth /api/oauth/usage");
    }

    #[test]
    fn empty_home_returns_the_route_shape() {
        let home = std::env::temp_dir().join(format!(
            "usage-dashboard-empty-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::create_dir_all(&home).unwrap();
        let body = load_quotas(&home, 1_787_745_600_000);
        assert_eq!(body.get_str("fetchedAt"), Some("2026-08-26T12:00:00.000Z"));
        let plans = body.get("plans").and_then(Json::as_arr).unwrap();
        assert!(plans.len() >= 3);
        for (index, id) in ["cursor", "grok", "claude"].iter().enumerate() {
            assert_eq!(plans[index].get_str("id"), Some(*id));
            assert_eq!(plans[index].get("ok").and_then(Json::as_bool), Some(false));
            assert!(plans[index].get_str("error").is_some());
            assert!(plans[index].get("bars").and_then(Json::as_arr).unwrap().is_empty());
            assert!(plans[index].get("stats").and_then(Json::as_arr).unwrap().is_empty());
            assert!(plans[index].get("usedPercent").unwrap().is_null());
        }
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn run_timeout_returns_command_stdout() {
        let out = run_timeout(Path::new("/bin/echo"), &["ok"], 2_000).unwrap();
        assert_eq!(out.trim(), "ok");
    }

    #[test]
    fn reads_cursor_token_from_linux_state_db() {
        let home = std::env::temp_dir().join(format!(
            "usage-dashboard-cursor-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let db_path = home.join(".config/Cursor/User/globalStorage/state.vscdb");
        fs::create_dir_all(db_path.parent().unwrap()).unwrap();
        let db = Db::open(db_path.to_str().unwrap()).unwrap();
        db.exec("CREATE TABLE ItemTable (key TEXT, value TEXT)")
            .unwrap();
        db.run(
            "INSERT INTO ItemTable (key, value) VALUES ('cursorAuth/accessToken', 'tok-123')",
            &[],
        )
        .unwrap();
        drop(db);
        let token = read_cursor_token(&home).unwrap();
        assert_eq!(token, "tok-123");
        let _ = fs::remove_dir_all(home);
    }

    fn local_epoch_ms(year: i32, month: i32, day: i32, hour: i32) -> i64 {
        let mut tm = zero_tm();
        tm.tm_year = year - 1900;
        tm.tm_mon = month - 1;
        tm.tm_mday = day;
        tm.tm_hour = hour;
        tm.tm_isdst = -1;
        // SAFETY: `tm` is a writable `struct tm`. `mktime` normalizes it in place.
        let secs = unsafe { mktime(&mut tm) };
        secs * 1000
    }
}
