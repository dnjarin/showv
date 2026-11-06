CREATE INDEX idx_customers_name ON customers(name);
CREATE INDEX idx_exchange_rates_lookup ON exchange_rates(currency_code, rate_date DESC);