use crate::{audit, error::AppError, security, state::AppState};
use rusqlite::OptionalExtension;
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelTax {
    id: i64,
    rate_bp: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelContext {
    business_name: String,
    usd_rate_micro: Option<i64>,
    rate_date: Option<String>,
    tax_rates: Vec<LabelTax>,
    without_barcode: i64,
}

#[derive(Serialize)]
pub struct AssignedCode {
    id: i64,
    barcode: String,
}

#[derive(Serialize)]
pub struct AssignResult {
    assigned: i64,
    items: Vec<AssignedCode>,
}

/// Dígito verificador EAN-13 de los 12 primeros dígitos.
fn ean13_check(d12: &str) -> u32 {
    let sum: u32 = d12
        .chars()
        .enumerate()
        .map(|(i, c)| c.to_digit(10).unwrap_or(0) * if i % 2 == 0 { 1 } else { 3 })
        .sum();
    (10 - sum % 10) % 10
}

/// Código interno: prefijo 200 (rango EAN reservado para uso interno) + 9 dígitos + verificador.
fn internal_ean13(seq: i64) -> String {
    let base = format!("200{:09}", seq);
    format!("{}{}", base, ean13_check(&base))
}

#[tauri::command]
pub async fn label_context(state: State<'_, AppState>) -> Result<LabelContext, AppError> {
    security::require_role(&state, security::STOCK_MANAGERS)?;
    let db = state.conn()?;

    let business_name: String = db
        .query_row(
            "SELECT COALESCE(NULLIF(trim(trade_name), ''), legal_name) FROM company WHERE id = 1",
            [],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or_default();

    let rate: Option<(i64, String)> = db
        .query_row(
            "SELECT rate_micro, rate_date FROM exchange_rates
             WHERE currency_code = 'USD' AND rate_date <= date('now','localtime')
             ORDER BY rate_date DESC, id DESC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;

    let tax_rates = db
        .prepare("SELECT id, rate_bp FROM tax_rates")?
        .query_map([], |r| {
            Ok(LabelTax {
                id: r.get(0)?,
                rate_bp: r.get(1)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let without_barcode: i64 = db.query_row(
        "SELECT COUNT(*) FROM products WHERE active = 1 AND (barcode IS NULL OR trim(barcode) = '')",
        [],
        |r| r.get(0),
    )?;

    Ok(LabelContext {
        business_name,
        usd_rate_micro: rate.as_ref().map(|r| r.0),
        rate_date: rate.map(|r| r.1),
        tax_rates,
        without_barcode,
    })
}

/// Asigna códigos EAN-13 internos a productos sin código de barras.
/// `ids` = solo esos productos; sin `ids` = todos los activos que no tengan.
#[tauri::command]
pub async fn assign_barcodes(
    state: State<'_, AppState>,
    ids: Option<Vec<i64>>,
) -> Result<AssignResult, AppError> {
    let me = security::require_role(&state, security::STOCK_MANAGERS)?;
    if ids.as_ref().is_some_and(|v| v.len() > 5000) {
        return Err(AppError::Validation("Demasiados productos a la vez".into()));
    }
    let mut db = state.conn()?;
    let tx = db.transaction()?;

    let targets: Vec<i64> = match ids {
        Some(v) => {
            let mut out = Vec::new();
            for id in v {
                let n: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM products
                     WHERE id = ?1 AND (barcode IS NULL OR trim(barcode) = '')",
                    [id],
                    |r| r.get(0),
                )?;
                if n > 0 && !out.contains(&id) {
                    out.push(id);
                }
            }
            out
        }
        None => tx
            .prepare(
                "SELECT id FROM products
                 WHERE active = 1 AND (barcode IS NULL OR trim(barcode) = '') ORDER BY id",
            )?
            .query_map([], |r| r.get(0))?
            .collect::<Result<Vec<i64>, _>>()?,
    };

    let max: Option<i64> = tx.query_row(
        "SELECT MAX(CAST(substr(barcode, 4, 9) AS INTEGER)) FROM products
         WHERE length(barcode) = 13 AND barcode LIKE '200%' AND barcode NOT GLOB '*[^0-9]*'",
        [],
        |r| r.get(0),
    )?;
    let mut seq = max.unwrap_or(0);

    let mut items = Vec::new();
    for id in targets {
        let code = loop {
            seq += 1;
            if seq > 999_999_999 {
                return Err(AppError::Validation(
                    "Se agotó el rango de códigos internos".into(),
                ));
            }
            let code = internal_ean13(seq);
            let used: i64 = tx.query_row(
                "SELECT COUNT(*) FROM products WHERE barcode = ?1",
                [&code],
                |r| r.get(0),
            )?;
            if used == 0 {
                break code;
            }
        };
        tx.execute(
            "UPDATE products SET barcode = ?1 WHERE id = ?2",
            rusqlite::params![code, id],
        )?;
        items.push(AssignedCode { id, barcode: code });
    }

    if !items.is_empty() {
        let detail = format!("{} códigos internos EAN-13", items.len());
        audit::log(
            &tx,
            Some(me.id),
            "barcodes_assigned",
            Some("product"),
            None,
            Some(&detail),
        )?;
    }
    tx.commit()?;
    Ok(AssignResult {
        assigned: items.len() as i64,
        items,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_digit_known_codes() {
        assert_eq!(ean13_check("590123412345"), 7); // 5901234123457
        assert_eq!(ean13_check("400638133393"), 1); // 4006381333931
    }

    #[test]
    fn internal_code_shape() {
        let c = internal_ean13(1);
        assert_eq!(c.len(), 13);
        assert!(c.starts_with("200000000001"));
        assert_eq!(ean13_check(&c[..12]).to_string(), c[12..]);
    }
}
