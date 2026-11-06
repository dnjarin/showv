//! Libros de ventas y de compras (informativos, expresados en bolívares).
use crate::{error::AppError, security, state::AppState};
use chrono::NaiveDate;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::State;

fn div_round(n: i128, d: i128) -> i64 {
    ((n + d / 2) / d) as i64
}

/// Convierte a bolívares con la tasa guardada en el documento (micro-unidades).
fn ves(minor: i64, rate_micro: i64) -> i64 {
    div_round(minor as i128 * rate_micro as i128, 1_000_000)
}

fn date_arg(s: &str, what: &str) -> Result<String, AppError> {
    NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d")
        .map(|d| d.format("%Y-%m-%d").to_string())
        .map_err(|_| AppError::Validation(format!("Fecha «{what}» inválida")))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookFilter {
    from: String,
    to: String,
}

fn range(f: &BookFilter) -> Result<(String, String), AppError> {
    let from = date_arg(&f.from, "desde")?;
    let to = date_arg(&f.to, "hasta")?;
    if from > to {
        return Err(AppError::Validation("La fecha «desde» no puede ser posterior a «hasta»".into()));
    }
    Ok((from, to))
}

/// Montos en bolívares por alícuota. Se usa tanto en filas como en totales.
#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Amounts {
    total_ves_minor: i64,
    exempt_ves_minor: i64,
    base_general_ves_minor: i64,
    iva_general_ves_minor: i64,
    base_reduced_ves_minor: i64,
    iva_reduced_ves_minor: i64,
    base_extra_ves_minor: i64,
    iva_extra_ves_minor: i64,
}

impl Amounts {
    fn finish(&mut self) {
        self.total_ves_minor = self.exempt_ves_minor
            + self.base_general_ves_minor
            + self.iva_general_ves_minor
            + self.base_reduced_ves_minor
            + self.iva_reduced_ves_minor
            + self.base_extra_ves_minor
            + self.iva_extra_ves_minor;
    }
    fn add(&mut self, o: &Amounts) {
        self.total_ves_minor += o.total_ves_minor;
        self.exempt_ves_minor += o.exempt_ves_minor;
        self.base_general_ves_minor += o.base_general_ves_minor;
        self.iva_general_ves_minor += o.iva_general_ves_minor;
        self.base_reduced_ves_minor += o.base_reduced_ves_minor;
        self.iva_reduced_ves_minor += o.iva_reduced_ves_minor;
        self.base_extra_ves_minor += o.base_extra_ves_minor;
        self.iva_extra_ves_minor += o.iva_extra_ves_minor;
    }
}

// ---------- Libro de ventas ----------
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SalesBookRow {
    id: i64,
    date: String,
    document: String,
    kind: String,
    related: Option<String>,
    customer_name: Option<String>,
    customer_doc: Option<String>,
    voided: bool,
    amounts: Amounts,
    igtf_ves_minor: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SalesBook {
    issuer: String,
    rows: Vec<SalesBookRow>,
    totals: Amounts,
    igtf_ves_minor: i64,
}

fn issuer(conn: &Connection) -> Result<String, AppError> {
    let (rif, name): (String, String) = conn.query_row(
        "SELECT rif, legal_name FROM company WHERE id = 1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok(format!("{name} · RIF {rif}"))
}

fn label(series: &str, number: i64) -> String {
    format!("{series}-{number:06}")
}

fn bucket_sales(conn: &Connection, doc_id: i64) -> Result<[i64; 7], AppError> {
    // [exento, base gen, iva gen, base red, iva red, base adi, iva adi] en moneda del documento
    let mut b = [0i64; 7];
    let mut st = conn.prepare(
        "SELECT tax_code, tax_minor, line_total_minor FROM document_items WHERE document_id = ?1",
    )?;
    let rows = st.query_map([doc_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
    })?;
    for row in rows {
        let (code, tax, line) = row?;
        let base = line - tax;
        if tax == 0 {
            b[0] += base;
        } else {
            let i = match code.as_str() {
                "REDUCIDA" => 3,
                "ADICIONAL" => 5,
                _ => 1,
            };
            b[i] += base;
            b[i + 1] += tax;
        }
    }
    Ok(b)
}

#[tauri::command]
pub async fn sales_book(state: State<'_, AppState>, filter: BookFilter) -> Result<SalesBook, AppError> {
    security::require_role(&state, &["admin"])?;
    let (from, to) = range(&filter)?;
    let db = state.conn()?;

    struct Head {
        id: i64,
        date: String,
        series: String,
        number: i64,
        doc_type: String,
        status: String,
        related: Option<String>,
        cname: Option<String>,
        cdoc: Option<String>,
        rate: i64,
        igtf: i64,
    }
    let heads = db
        .prepare(
            "SELECT d.id, date(d.issued_at, 'localtime'), d.series, d.number, d.doc_type, d.status,
                    r.series, r.number, d.customer_name,
                    CASE WHEN d.customer_id_number IS NULL THEN NULL
                         ELSE COALESCE(d.customer_id_type, '') || '-' || d.customer_id_number END,
                    d.exchange_rate_micro, d.igtf_minor
             FROM documents d LEFT JOIN documents r ON r.id = d.related_document_id
             WHERE d.doc_type IN ('COMPROBANTE', 'DEVOLUCION') AND d.status IN ('issued', 'voided')
               AND date(d.issued_at, 'localtime') BETWEEN ?1 AND ?2
             ORDER BY d.issued_at, d.id",
        )?
        .query_map(params![from, to], |r| {
            let rs: Option<String> = r.get(6)?;
            let rn: Option<i64> = r.get(7)?;
            Ok(Head {
                id: r.get(0)?, date: r.get(1)?, series: r.get(2)?, number: r.get(3)?,
                doc_type: r.get(4)?, status: r.get(5)?,
                related: match (rs, rn) { (Some(s), Some(n)) => Some(label(&s, n)), _ => None },
                cname: r.get(8)?, cdoc: r.get(9)?, rate: r.get(10)?, igtf: r.get(11)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut rows = Vec::with_capacity(heads.len());
    let mut totals = Amounts::default();
    let mut igtf_total = 0i64;
    for h in heads {
        let voided = h.status == "voided";
        let mut a = Amounts::default();
        let mut igtf = 0;
        if !voided {
            let b = bucket_sales(&db, h.id)?;
            let sign = if h.doc_type == "DEVOLUCION" { -1 } else { 1 };
            a.exempt_ves_minor = sign * ves(b[0], h.rate);
            a.base_general_ves_minor = sign * ves(b[1], h.rate);
            a.iva_general_ves_minor = sign * ves(b[2], h.rate);
            a.base_reduced_ves_minor = sign * ves(b[3], h.rate);
            a.iva_reduced_ves_minor = sign * ves(b[4], h.rate);
            a.base_extra_ves_minor = sign * ves(b[5], h.rate);
            a.iva_extra_ves_minor = sign * ves(b[6], h.rate);
            a.finish();
            igtf = sign * ves(h.igtf, h.rate);
        }
        totals.add(&a);
        igtf_total += igtf;
        rows.push(SalesBookRow {
            id: h.id,
            date: h.date,
            document: label(&h.series, h.number),
            kind: if h.doc_type == "DEVOLUCION" { "Nota de crédito".into() } else { "Comprobante".into() },
            related: h.related,
            customer_name: h.cname,
            customer_doc: h.cdoc,
            voided,
            amounts: a,
            igtf_ves_minor: igtf,
        });
    }
    Ok(SalesBook { issuer: issuer(&db)?, rows, totals, igtf_ves_minor: igtf_total })
}

// ---------- Libro de compras ----------
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchasesBookRow {
    id: i64,
    date: String,
    number: String,
    supplier_name: String,
    supplier_doc: String,
    invoice_number: Option<String>,
    invoice_control: Option<String>,
    voided: bool,
    no_rate: bool,
    amounts: Amounts,
    iva_withheld_ves_minor: i64,
    voucher: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchasesBook {
    issuer: String,
    rows: Vec<PurchasesBookRow>,
    totals: Amounts,
    iva_withheld_ves_minor: i64,
    without_rate: i64,
}

#[tauri::command]
pub async fn purchases_book(
    state: State<'_, AppState>,
    filter: BookFilter,
) -> Result<PurchasesBook, AppError> {
    security::require_role(&state, &["admin"])?;
    let (from, to) = range(&filter)?;
    let db = state.conn()?;

    let mut st = db.prepare(
        "SELECT p.id, COALESCE(p.invoice_date, date(p.created_at, 'localtime')) AS d, p.number,
                p.supplier_name, p.supplier_doc, p.invoice_number, p.invoice_control, p.status,
                p.currency_code, p.exchange_rate_micro, p.total_minor, p.exempt_minor,
                p.iva_rate_bp, p.iva_minor, w.amount_ves_minor, w.voucher_number
         FROM purchases p
         LEFT JOIN withholdings w
                ON w.purchase_id = p.id AND w.kind = 'IVA' AND w.status = 'active'
         WHERE p.opening = 0
           AND COALESCE(p.invoice_date, date(p.created_at, 'localtime')) BETWEEN ?1 AND ?2
         ORDER BY d, p.id",
    )?;
    let mut q = st.query(params![from, to])?;

    let mut rows = Vec::new();
    let mut totals = Amounts::default();
    let mut withheld_total = 0i64;
    let mut without_rate = 0i64;
    while let Some(r) = q.next()? {
        let status: String = r.get(7)?;
        let cur: String = r.get(8)?;
        let rate_opt: Option<i64> = r.get(9)?;
        let total: i64 = r.get(10)?;
        let exempt: i64 = r.get(11)?;
        let rate_bp: i64 = r.get(12)?;
        let iva: i64 = r.get(13)?;
        let withheld: Option<i64> = r.get(14)?;
        let voided = status == "voided";

        let rate = if cur == "VES" { Some(1_000_000) } else { rate_opt };
        let mut a = Amounts::default();
        let mut no_rate = false;
        let mut held = 0;
        if !voided {
            match rate {
                None => {
                    no_rate = true;
                    without_rate += 1;
                }
                Some(rt) => {
                    let taxable = total - exempt;
                    if rate_bp == 0 {
                        a.exempt_ves_minor = ves(total, rt);
                    } else {
                        a.exempt_ves_minor = ves(exempt, rt);
                        let (bi, ii) = if rate_bp >= 2500 {
                            (&mut a.base_extra_ves_minor, &mut a.iva_extra_ves_minor)
                        } else if rate_bp <= 1000 {
                            (&mut a.base_reduced_ves_minor, &mut a.iva_reduced_ves_minor)
                        } else {
                            (&mut a.base_general_ves_minor, &mut a.iva_general_ves_minor)
                        };
                        *bi = ves(taxable, rt);
                        *ii = ves(iva, rt);
                    }
                    a.finish();
                    held = withheld.unwrap_or(0);
                }
            }
        }
        totals.add(&a);
        withheld_total += held;
        let number: i64 = r.get(2)?;
        rows.push(PurchasesBookRow {
            id: r.get(0)?,
            date: r.get(1)?,
            number: format!("C-{number:06}"),
            supplier_name: r.get(3)?,
            supplier_doc: r.get(4)?,
            invoice_number: r.get(5)?,
            invoice_control: r.get(6)?,
            voided,
            no_rate,
            amounts: a,
            iva_withheld_ves_minor: held,
            voucher: if voided { None } else { r.get(15)? },
        });
    }
    Ok(PurchasesBook {
        issuer: issuer(&db)?,
        rows,
        totals,
        iva_withheld_ves_minor: withheld_total,
        without_rate,
    })
}
