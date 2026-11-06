-- Las cotizaciones emitidas con la migración 031 se guardaron en hora local (UTC-4) y la app
-- interpreta todas las fechas como UTC. Se corrigen esas filas; las nuevas ya se guardan en UTC.
UPDATE quote_docs SET created_at = datetime(created_at, '+4 hours');
