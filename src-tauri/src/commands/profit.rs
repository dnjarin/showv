//! Utilidad y rentabilidad, y datos del panel de inicio.
use crate::{
    error::AppError,
    security::{self, ALL_ROLES},
    state::AppState,
};
use chrono::{Datelike, Duration, Local, NaiveDate};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tauri::State;

fn div_round(n: i128, d: i128) -> i64 {
    ((n + d / 2) / d) as i64
}

fn usd_rate(conn: &Connection) -> Result<Option<i64>, AppError> {
    Ok(conn
        .query_row(
            "SELECT rate_micro FROM exchange_rates
             WHERE currency_code = 'USD' AND rate_date <= date('now','localtime')
             ORDER BY rate_date DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()?)
}

/// Tasa efectiva de un documento: la guardada si es válida; si no, la vigente.
fn eff_rate(doc_rate: i64, fallback: Option<i64>) -> Option<i64> {
    if doc_rate > 1_000_000 {
        Some(doc_rate)
    } else {
        fallback
    }
}

/// (bolívares, dólares) de un monto en `cur`.
fn both(amount: i64, cur: &str, rate: Option<i64>) -> (i64, i64) {
    if cur == "USD" {
        let ves = rate.map_or(0, |r| div_round(amount as i128 * r as i128, 1_000_000));
        (ves, amount)
    } else {
        let usd = rate.map_or(0, |r| div_round(amount as i128 * 1_000_000, r as i128));
        (amount, usd)
    }
}

fn parse_day(s: &str) -> Result<NaiveDate, AppError> {
    NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d")
        .map_err(|_| AppError::Validation("Fecha inválida".into()))
}

fn margin_bp(profit: i64, revenue: i64) -> i64 {
    if revenue <= 0 {
        0
    } else {
        div_round(profit as i128 * 10_000, revenue as i128)
    }
}

// ---------- Núcleo de cálculo ----------
#[derive(Default, Clone)]
struct ProductAgg {
    sku: Option<String>,
    name: String,
    qty: i64,
    rev_usd: i64,
    cost_usd: i64,
}

#[derive(Default)]
struct Core {
    rev_ves: i64,
    rev_usd: i64,
    cost_ves: i64,
    cost_usd: i64,
    est_cost_usd: i64,
    no_cost_lines: i64,
    sales_docs: i64,
    products: BTreeMap<i64, ProductAgg>,
    days: BTreeMap<String, (i64, i64)>, // día -> (ventas USD, utilidad USD)
}

fn compute_core(
    conn: &Connection,
    from: &str,
    to: &str,
    only_cashier: Option<i64>,
    fallback: Option<i64>,
) -> Result<Core, AppError> {
    let mut core = Core::default();
    core.sales_docs = conn.query_row(
        "SELECT COUNT(*) FROM documents
         WHERE status = 'issued' AND doc_type = 'COMPROBANTE'
           AND date(issued_at, 'localtime') BETWEEN ?1 AND ?2
           AND (?3 IS NULL OR cashier_id = ?3)",
        params![from, to, only_cashier],
        |r| r.get(0),
    )?;

    let mut st = conn.prepare(
        "SELECT d.doc_type, d.currency_code, d.exchange_rate_micro, di.product_id, p.sku,
                di.description, di.quantity, di.line_total_minor - di.tax_minor, di.restocked,
                COALESCE(c.unit_cost_minor, sc.unit_cost_minor),
                COALESCE(c.cost_currency, sc.cost_currency),
                COALESCE(c.estimated, sc.estimated, 0),
                date(d.issued_at, 'localtime')
         FROM document_items di
         JOIN documents d ON d.id = di.document_id
         LEFT JOIN products p ON p.id = di.product_id
         LEFT JOIN item_costs c ON c.item_id = di.id
         LEFT JOIN item_costs sc ON sc.item_id = di.source_item_id
         WHERE d.status = 'issued' AND d.doc_type IN ('COMPROBANTE', 'DEVOLUCION')
           AND date(d.issued_at, 'localtime') BETWEEN ?1 AND ?2
           AND (?3 IS NULL OR d.cashier_id = ?3)",
    )?;
    let mut q = st.query(params![from, to, only_cashier])?;
    while let Some(r) = q.next()? {
        let doc_type: String = r.get(0)?;
        let cur: String = r.get(1)?;
        let doc_rate: i64 = r.get(2)?;
        let product_id: Option<i64> = r.get(3)?;
        let sku: Option<String> = r.get(4)?;
        let name: String = r.get(5)?;
        let qty: i64 = r.get(6)?;
        let base: i64 = r.get(7)?;
        let restocked: i64 = r.get(8)?;
        let unit_cost: Option<i64> = r.get(9)?;
        let cost_cur: Option<String> = r.get(10)?;
        let estimated: i64 = r.get(11)?;
        let day: String = r.get(12)?;

        let rate = eff_rate(doc_rate, fallback);
        let is_return = doc_type == "DEVOLUCION";
        let sign: i64 = if is_return { -1 } else { 1 };

        let (rev_ves, rev_usd) = both(base, &cur, rate);
        let (rev_ves, rev_usd) = (sign * rev_ves, sign * rev_usd);

        // Costo: en venta suma; en devolución solo se recupera si el producto volvió al inventario.
        let (mut c_ves, mut c_usd) = (0i64, 0i64);
        match (unit_cost, cost_cur.as_deref()) {
            (Some(uc), Some(cc)) => {
                if !is_return || restocked == 1 {
                    let (v, u) = both(uc.saturating_mul(qty), cc, rate);
                    c_ves = sign * v;
                    c_usd = sign * u;
                }
            }
            _ => core.no_cost_lines += 1,
        }

        core.rev_ves += rev_ves;
        core.rev_usd += rev_usd;
        core.cost_ves += c_ves;
        core.cost_usd += c_usd;
        if estimated == 1 {
            core.est_cost_usd += c_usd;
        }
        let key = product_id.unwrap_or(-1);
        let p = core.products.entry(key).or_default();
        if p.name.is_empty() {
            p.name = name;
            p.sku = sku;
        }
        p.qty += sign * qty;
        p.rev_usd += rev_usd;
        p.cost_usd += c_usd;
        let d = core.days.entry(day).or_insert((0, 0));
        d.0 += rev_usd;
        d.1 += rev_usd - c_usd;
    }
    Ok(core)
}

struct ExpTotals {
    usd: i64,
    ves: i64,
    by_category: Vec<(String, i64, i64)>,
}

fn expense_totals(
    conn: &Connection,
    from: &str,
    to: &str,
    fallback: Option<i64>,
) -> Result<ExpTotals, AppError> {
    let mut st = conn.prepare(
        "SELECT c.name, e.currency_code, e.amount_minor, e.amount_usd_minor, e.exchange_rate_micro
         FROM expenses e JOIN expense_categories c ON c.id = e.category_id
         WHERE e.voided_at IS NULL AND e.expense_date BETWEEN ?1 AND ?2",
    )?;
    let mut q = st.query(params![from, to])?;
    let mut t = ExpTotals { usd: 0, ves: 0, by_category: Vec::new() };
    let mut map: BTreeMap<String, (i64, i64)> = BTreeMap::new();
    while let Some(r) = q.next()? {
        let cat: String = r.get(0)?;
        let cur: String = r.get(1)?;
        let amount: i64 = r.get(2)?;
        let usd: i64 = r.get(3)?;
        let rate: Option<i64> = r.get(4)?;
        let ves = if cur == "VES" {
            amount
        } else {
            rate.or(fallback).map_or(0, |x| div_round(amount as i128 * x as i128, 1_000_000))
        };
        t.usd += usd;
        t.ves += ves;
        let e = map.entry(cat).or_insert((0, 0));
        e.0 += usd;
        e.1 += ves;
    }
    t.by_category = map.into_iter().map(|(k, v)| (k, v.0, v.1)).collect();
    t.by_category.sort_by(|a, b| b.1.cmp(&a.1));
    Ok(t)
}

// ---------- Reporte de utilidad ----------
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductProfit {
    sku: Option<String>,
    name: String,
    quantity: i64,
    revenue_usd_minor: i64,
    cost_usd_minor: i64,
    profit_usd_minor: i64,
    margin_bp: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryExpense {
    category: String,
    usd_minor: i64,
    ves_minor: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayProfit {
    day: String,
    revenue_usd_minor: i64,
    profit_usd_minor: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfitReport {
    sales_docs: i64,
    revenue_usd_minor: i64,
    revenue_ves_minor: i64,
    cost_usd_minor: i64,
    cost_ves_minor: i64,
    gross_usd_minor: i64,
    gross_ves_minor: i64,
    margin_bp: i64,
    expenses_usd_minor: i64,
    expenses_ves_minor: i64,
    net_usd_minor: i64,
    net_ves_minor: i64,
    estimated_cost_share_bp: i64,
    no_cost_lines: i64,
    by_product: Vec<ProductProfit>,
    by_category: Vec<CategoryExpense>,
    by_day: Vec<DayProfit>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfitFilter {
    from: String,
    to: String,
}

#[tauri::command]
pub async fn profit_report(
    state: State<'_, AppState>,
    filter: ProfitFilter,
) -> Result<ProfitReport, AppError> {
    security::require_role(&state, &["admin"])?;
    let (f, t) = (parse_day(&filter.from)?, parse_day(&filter.to)?);
    if t < f {
        return Err(AppError::Validation("La fecha final es anterior a la inicial".into()));
    }
    if (t - f).num_days() > 366 {
        return Err(AppError::Validation("El rango máximo es de un año".into()));
    }
    let (from, to) = (f.format("%Y-%m-%d").to_string(), t.format("%Y-%m-%d").to_string());
    let db = state.conn()?;
    let fallback = usd_rate(&db)?;
    let core = compute_core(&db, &from, &to, None, fallback)?;
    let exp = expense_totals(&db, &from, &to, fallback)?;

    let gross_usd = core.rev_usd - core.cost_usd;
    let gross_ves = core.rev_ves - core.cost_ves;
    let mut by_product: Vec<ProductProfit> = core
        .products
        .values()
        .map(|p| ProductProfit {
            sku: p.sku.clone(),
            name: p.name.clone(),
            quantity: p.qty,
            revenue_usd_minor: p.rev_usd,
            cost_usd_minor: p.cost_usd,
            profit_usd_minor: p.rev_usd - p.cost_usd,
            margin_bp: margin_bp(p.rev_usd - p.cost_usd, p.rev_usd),
        })
        .collect();
    by_product.sort_by(|a, b| b.profit_usd_minor.cmp(&a.profit_usd_minor));

    Ok(ProfitReport {
        sales_docs: core.sales_docs,
        revenue_usd_minor: core.rev_usd,
        revenue_ves_minor: core.rev_ves,
        cost_usd_minor: core.cost_usd,
        cost_ves_minor: core.cost_ves,
        gross_usd_minor: gross_usd,
        gross_ves_minor: gross_ves,
        margin_bp: margin_bp(gross_usd, core.rev_usd),
        expenses_usd_minor: exp.usd,
        expenses_ves_minor: exp.ves,
        net_usd_minor: gross_usd - exp.usd,
        net_ves_minor: gross_ves - exp.ves,
        estimated_cost_share_bp: if core.cost_usd > 0 {
            div_round(core.est_cost_usd as i128 * 10_000, core.cost_usd as i128)
        } else {
            0
        },
        no_cost_lines: core.no_cost_lines,
        by_product,
        by_category: exp
            .by_category
            .into_iter()
            .map(|(category, usd_minor, ves_minor)| CategoryExpense { category, usd_minor, ves_minor })
            .collect(),
        by_day: core
            .days
            .into_iter()
            .map(|(day, (r, p))| DayProfit { day, revenue_usd_minor: r, profit_usd_minor: p })
            .collect(),
    })
}

// ---------- Panel de inicio ----------
// Los saldos usan las mismas fórmulas que las pantallas de cuentas por cobrar y por pagar.
use super::payables::BALANCE_SQL as AP_BALANCE;
use super::receivables::BALANCE_SQL as AR_BALANCE;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    total_usd_minor: i64,
    overdue_usd_minor: i64,
    parties: i64,
    docs: i64,
}

fn pending(conn: &Connection, sql: &str, fallback: Option<i64>) -> Result<Pending, AppError> {
    let mut st = conn.prepare(sql)?;
    let mut q = st.query([])?;
    let mut out = Pending::default();
    let mut seen: Vec<i64> = Vec::new();
    while let Some(r) = q.next()? {
        let cur: String = r.get(0)?;
        let bal: i64 = r.get(1)?;
        let overdue: i64 = r.get(2)?;
        let party: i64 = r.get(3)?;
        if bal <= 0 {
            continue;
        }
        let usd = both(bal, &cur, fallback).1;
        out.total_usd_minor += usd;
        if overdue == 1 {
            out.overdue_usd_minor += usd;
        }
        out.docs += 1;
        if !seen.contains(&party) {
            seen.push(party);
        }
    }
    out.parties = seen.len() as i64;
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Period {
    revenue_usd_minor: i64,
    revenue_ves_minor: i64,
    docs: i64,
    avg_ticket_usd_minor: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminBlocks {
    profit_usd_minor: i64,
    profit_ves_minor: i64,
    margin_bp: i64,
    expenses_usd_minor: i64,
    expenses_ves_minor: i64,
    net_usd_minor: i64,
    net_ves_minor: i64,
    prev_revenue_usd_minor: i64,
    change_bp: Option<i64>,
    receivable: Pending,
    payable: Pending,
    stock_value_usd_minor: i64,
    estimated_cost: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockBlock {
    products: i64,
    low: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RateBlock {
    rate_micro: i64,
    rate_date: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopProduct {
    name: String,
    quantity: i64,
    revenue_usd_minor: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayBar {
    day: String,
    revenue_usd_minor: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CashBlock {
    open: bool,
    opened_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    role: String,
    month_start: String,
    today: Option<Period>,
    month: Option<Period>,
    admin: Option<AdminBlocks>,
    stock: Option<StockBlock>,
    rate: Option<RateBlock>,
    cash: Option<CashBlock>,
    top_products: Vec<TopProduct>,
    last_days: Vec<DayBar>,
}

fn period_of(core: &Core) -> Period {
    Period {
        revenue_usd_minor: core.rev_usd,
        revenue_ves_minor: core.rev_ves,
        docs: core.sales_docs,
        avg_ticket_usd_minor: if core.sales_docs > 0 { core.rev_usd / core.sales_docs } else { 0 },
    }
}

#[tauri::command]
pub async fn dashboard_summary(state: State<'_, AppState>) -> Result<Dashboard, AppError> {
    let me = security::require_role(&state, ALL_ROLES)?;
    let is_admin = me.role == "admin";
    let sells = is_admin || me.role == "cajero";
    let db = state.conn()?;

    let today = Local::now().date_naive();
    let month_start = today.with_day(1).unwrap_or(today);
    let fmt = |d: NaiveDate| d.format("%Y-%m-%d").to_string();
    let fallback = usd_rate(&db)?;
    let only = if is_admin { None } else { Some(me.id) };

    let rate = db
        .query_row(
            "SELECT rate_micro, rate_date FROM exchange_rates
             WHERE currency_code = 'USD' AND rate_date <= date('now','localtime')
             ORDER BY rate_date DESC LIMIT 1",
            [],
            |r| Ok(RateBlock { rate_micro: r.get(0)?, rate_date: r.get(1)? }),
        )
        .optional()?;

    let mut out = Dashboard {
        role: me.role.clone(),
        month_start: fmt(month_start),
        today: None,
        month: None,
        admin: None,
        stock: None,
        rate: if sells { rate } else { None },
        cash: None,
        top_products: vec![],
        last_days: vec![],
    };

    if sells {
        let t = compute_core(&db, &fmt(today), &fmt(today), only, fallback)?;
        out.today = Some(period_of(&t));
        let m = compute_core(&db, &fmt(month_start), &fmt(today), only, fallback)?;
        out.month = Some(period_of(&m));

        let mut tops: Vec<&ProductAgg> = m.products.values().filter(|p| p.qty > 0).collect();
        tops.sort_by(|a, b| b.qty.cmp(&a.qty));
        out.top_products = tops
            .into_iter()
            .take(5)
            .map(|p| TopProduct { name: p.name.clone(), quantity: p.qty, revenue_usd_minor: p.rev_usd })
            .collect();

        let l = compute_core(&db, &fmt(today - Duration::days(13)), &fmt(today), only, fallback)?;
        out.last_days = (0..14)
            .map(|i| {
                let d = fmt(today - Duration::days(13 - i));
                let v = l.days.get(&d).map_or(0, |x| x.0);
                DayBar { day: d, revenue_usd_minor: v }
            })
            .collect();

        let open: Option<String> = db
            .query_row(
                "SELECT opened_at FROM cash_sessions WHERE user_id = ?1 AND closed_at IS NULL",
                [me.id],
                |r| r.get(0),
            )
            .optional()?;
        out.cash = Some(CashBlock { open: open.is_some(), opened_at: open });

        if is_admin {
            // Mismo tramo del mes anterior.
            let prev_last = month_start - Duration::days(1);
            let prev_start = prev_last.with_day(1).unwrap_or(prev_last);
            let prev_end = std::cmp::min(
                prev_last,
                prev_start + Duration::days(today.day() as i64 - 1),
            );
            let p = compute_core(&db, &fmt(prev_start), &fmt(prev_end), None, fallback)?;
            let exp = expense_totals(&db, &fmt(month_start), &fmt(today), fallback)?;
            let gross_usd = m.rev_usd - m.cost_usd;
            let gross_ves = m.rev_ves - m.cost_ves;

            let receivable = pending(
                &db,
                &format!(
                    "SELECT d.currency_code, {AR_BALANCE},
                            CASE WHEN d.due_date IS NOT NULL AND d.due_date < date('now','localtime')
                                 THEN 1 ELSE 0 END,
                            d.customer_id
                     FROM documents d
                     WHERE d.credit_sale = 1 AND d.status = 'issued' AND d.customer_id IS NOT NULL"
                ),
                fallback,
            )?;
            let payable = pending(
                &db,
                &format!(
                    "SELECT p.currency_code, {AP_BALANCE},
                            CASE WHEN p.due_date IS NOT NULL AND p.due_date < date('now','localtime')
                                 THEN 1 ELSE 0 END,
                            p.supplier_id
                     FROM purchases p
                     WHERE p.on_credit = 1 AND p.status = 'received'"
                ),
                fallback,
            )?;

            // Inventario valorizado a costo.
            let mut stock_value = 0i64;
            {
                let mut st = db.prepare(
                    "SELECT p.price_currency, p.cost_minor,
                            COALESCE((SELECT SUM(m.quantity) FROM stock_movements m WHERE m.product_id = p.id), 0)
                     FROM products p WHERE p.active = 1 AND p.track_stock = 1",
                )?;
                let mut q = st.query([])?;
                while let Some(r) = q.next()? {
                    let cur: String = r.get(0)?;
                    let cost: i64 = r.get(1)?;
                    let stock: i64 = r.get(2)?;
                    stock_value += both(cost.saturating_mul(stock.max(0)), &cur, fallback).1;
                }
            }

            out.admin = Some(AdminBlocks {
                profit_usd_minor: gross_usd,
                profit_ves_minor: gross_ves,
                margin_bp: margin_bp(gross_usd, m.rev_usd),
                expenses_usd_minor: exp.usd,
                expenses_ves_minor: exp.ves,
                net_usd_minor: gross_usd - exp.usd,
                net_ves_minor: gross_ves - exp.ves,
                prev_revenue_usd_minor: p.rev_usd,
                change_bp: if p.rev_usd > 0 {
                    Some(div_round((m.rev_usd - p.rev_usd) as i128 * 10_000, p.rev_usd as i128))
                } else {
                    None
                },
                receivable,
                payable,
                stock_value_usd_minor: stock_value,
                estimated_cost: m.est_cost_usd != 0,
            });
        }
    }

    if is_admin || me.role == "almacen" {
        let (products, low): (i64, i64) = db.query_row(
            "SELECT COUNT(*),
                    COALESCE(SUM(CASE WHEN s <= min_stock THEN 1 ELSE 0 END), 0)
             FROM (SELECT p.min_stock AS min_stock,
                          COALESCE((SELECT SUM(m.quantity) FROM stock_movements m
                                    WHERE m.product_id = p.id), 0) AS s
                   FROM products p WHERE p.active = 1 AND p.track_stock = 1)",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        out.stock = Some(StockBlock { products, low });
    }
    Ok(out)
}
