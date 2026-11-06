mod audit;
mod backup;
mod commands;
mod crypto;
mod db;
mod error;
mod keyplan;
mod lan;
mod lan_dispatch;
mod lan_guard;
mod security;
mod state;
mod tls;

use std::time::Duration;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let db_path = dir.join("inventario.db");
            //println!("📁 Base de datos en: {}", db_path.display());
            let conn = db::open(&db_path)?;

            // Respaldo automático al abrir (si el último tiene más de 24 h)
            let bdir = backup::dir(&dir);
            if let Err(e) = backup::auto_if_due(&conn, &bdir) {
                eprintln!("Respaldo automático falló: {e}");
            }
            app.manage(state::AppState::new(conn));

            // Modo red (opcional): solo si el administrador lo activó; abre el servidor para otros puestos.
            let lan_cfg = lan::load_config(&dir);
            lan::start(app.handle(), &lan_cfg);

            // Si la app queda abierta varios días, se revisa cada hora
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(3600));
                let state = handle.state::<state::AppState>();
                if let Ok(conn) = state.conn() {
                    if let Err(e) = backup::auto_if_due(&conn, &bdir) {
                        eprintln!("Respaldo automático falló: {e}");
                    }
                };
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::lan::lan_info,
            commands::lan::lan_settings_get,
            commands::lan::lan_settings_save,
            commands::keys::key_status,
            commands::keys::key_recovery_show,
            commands::keys::key_confirm_saved,
            commands::auth::needs_setup,
            commands::auth::complete_setup,
            commands::auth::login,
            commands::auth::logout,
            commands::auth::current_user,
            commands::auth::keep_alive,
            commands::auth::create_user,
            commands::users::list_users,
            commands::users::update_user,
            commands::users::set_user_active,
            commands::users::reset_user_password,
            commands::users::unlock_user,
            commands::users::change_own_password,
            commands::backups::backup_status,
            commands::backups::backup_create,
            commands::backups::backup_set_extra_dir,
            commands::backups::backup_restore,
            commands::catalog::catalog_options,
            commands::catalog::create_category,
            commands::catalog::list_products,
            commands::catalog::create_product,
            commands::catalog::update_product,
            commands::catalog::set_product_active,
            commands::inventory::adjust_stock,
            commands::inventory::list_movements,
            commands::customers::list_customers,
            commands::customers::create_customer,
            commands::customers::update_customer,
            commands::customers::set_customer_active,
            commands::rates::exchange_rates_overview,
            commands::rates::set_exchange_rate,
            commands::sales::quote_sale,
            commands::sales::issue_sale,
            commands::sales::get_document,
            commands::sales::list_documents,
            commands::sales::void_document,
            commands::returns::return_candidates,
            commands::returns::quote_return,
            commands::returns::create_return,
            commands::returns::get_return,
            commands::receivables::ar_credit_info,
            commands::receivables::ar_summary,
            commands::receivables::ar_customer,
            commands::receivables::ar_set_credit,
            commands::receivables::ar_receive,
            commands::receivables::ar_get_receipt,
            commands::receivables::ar_apply_credit,
            commands::receivables::ar_void_receipt,
            commands::payables::ap_summary,
            commands::payables::ap_supplier,
            commands::payables::ap_pay,
            commands::payables::ap_void_payment,
            commands::payables::ap_get_payment,
            commands::expenses::list_expense_categories,
            commands::expenses::save_expense_category,
            commands::expenses::set_expense_category_active,
            commands::expenses::create_expense,
            commands::expenses::list_expenses,
            commands::expenses::void_expense,
            commands::expenses::create_cash_movement,
            commands::expenses::list_cash_movements,
            commands::expenses::void_cash_movement,
            commands::books::sales_book,
            commands::books::purchases_book,
            commands::profit::profit_report,
            commands::profit::dashboard_summary,
            commands::imports::import_products_preview,
            commands::imports::import_apply,
            commands::imports::import_cancel,
            commands::imports::import_list_batches,
            commands::imports::import_get_batch,
            commands::imports::import_template,
            commands::imports::export_products,
            commands::imports::import_error_report,
            commands::legacy::legacy_preview,
            commands::legacy::legacy_apply,
            commands::legacy::legacy_history,
            commands::quotes::quote_preview,
            commands::quotes::quote_create,
            commands::quotes::quote_list,
            commands::quotes::quote_get,
            commands::quotes::quote_cancel,
            commands::quotes::quote_to_cart,
            commands::quotes::quote_mark_converted,
            commands::quotes::quote_style_get,
            commands::quotes::quote_style_save,
            commands::quotes::save_quote_file,
            commands::quotes::quote_context,
            commands::quotes::quote_issue,
            commands::quotes::quote_docs_list,
            commands::quotes::quote_doc_get,
            commands::pricing::price_list_options,
            commands::pricing::price_lists_admin,
            commands::pricing::save_price_list,
            commands::pricing::price_list_items,
            commands::pricing::set_price_list_item,
            commands::pricing::remove_price_list_item,
            commands::pricing::promotions_list,
            commands::pricing::save_promotion,
            commands::pricing::set_promotion_active,
            commands::purchase_orders::po_create,
            commands::purchase_orders::po_list,
            commands::purchase_orders::po_get,
            commands::purchase_orders::po_cancel,
            commands::purchase_orders::po_to_purchase,
            commands::purchase_orders::po_mark_received,
            commands::cash::cash_current,
            commands::cash::cash_open,
            commands::cash::cash_close,
            commands::cash::cash_history,
            commands::reports::sales_report,
            commands::reports::top_products,
            commands::reports::inventory_valuation,
            commands::reports::write_export,
            commands::recovery::generate_recovery_code,
            commands::recovery::recover_admin,
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::auditlog::list_audit,
            commands::catalog::categories_overview,
            commands::catalog::rename_category,
            commands::catalog::delete_category,
            commands::labels::label_context,
            commands::labels::assign_barcodes,
            commands::lots::list_lots,
            commands::lots::list_sale_lots,
            commands::lots::lots_report,
            commands::lots::set_product_lots,
            commands::lots::create_lot,
            commands::lots::update_lot,
            commands::sale_retentions::sret_doc_info,
            commands::sale_retentions::sret_register,
            commands::sale_retentions::sret_void,
            commands::sale_retentions::sret_list,
            commands::inventory::stock_overview,
            commands::inventory::transfer_stock,
            commands::inventory::list_transfers,
            commands::warehouses::list_warehouses,
            commands::warehouses::create_warehouse,
            commands::warehouses::update_warehouse,
            commands::warehouses::set_warehouse_active,
            commands::warehouses::set_sales_warehouse,
            commands::purchases::list_suppliers,
            commands::purchases::create_supplier,
            commands::purchases::update_supplier,
            commands::purchases::set_supplier_active,
            commands::purchases::quote_purchase,
            commands::purchases::create_purchase,
            commands::purchases::list_purchases,
            commands::purchases::get_purchase,
            commands::purchases::void_purchase,
            commands::retentions::retention_options,
            commands::retentions::get_withholding_config,
            commands::retentions::save_withholding_config,
            commands::retentions::save_islr_concept,
            commands::retentions::set_islr_concept_active,
            commands::retentions::set_supplier_retention,
            commands::retentions::list_withholdings,
            commands::retentions::get_withholding_voucher,
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar la aplicación");
}