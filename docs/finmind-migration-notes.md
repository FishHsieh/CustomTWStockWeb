# FinMind Migration Notes

## Goal

Reduce FinMind free-tier usage without changing the meaning of data shown by the site.

## Implemented first stage

`scripts/fetch_data.py` now requests the official TWSE and TPEx full-market daily-price endpoints once per update run. For an existing tracked symbol, the official row replaces the same date in its existing price history and moving averages are recalculated. If the official source has no row, is unavailable, or the symbol has no local history yet, the prior FinMind path remains the fallback.

The second stage is also implemented for individual institutional flows in both markets. The TWSE T86 report is fetched once for the TWSE price date; the TPEx `tpex_3insti_daily_trading` report is fetched once for the TPEx price date. Their foreign-investor (including foreign dealer self-trading), investment-trust, and dealer values are normalized into the existing `retail_flow` contract. 2330, 0050, and 6488 were checked field-by-field against FinMind. Emerging-market institutional flows remain on FinMind.

The third stage is implemented for monthly revenue. TWSE `t187ap05_L` and TPEx `mopsfin_t187ap05_O` provide the latest announced month for the full market. Their thousand-NTD amount is normalized to NTD, then replaces only that month in the existing local revenue history before YoY/MoM are recalculated. 2330 and 6488 matched FinMind's revenue and the resulting YoY/MoM values exactly after this unit conversion.

The fourth stage is implemented for the listed-market aggregate institutional-money charts. FinMind's `TaiwanStockTotalInstitutionalInvestors` values matched TWSE BFI82U exactly on 2026-09-24, including foreign, trust, dealer, and total amounts. A 2024-08-16 check with non-zero foreign-dealer self-trading also matched its existing component convention. The official latest row now replaces only that date in the existing `macro.json` history.

The fifth stage is implemented for TAIFEX TX futures positions. The official `MarketDataOfMajorInstitutionalTradersDetailsOfFuturesContractsBytheDate` endpoint reports long/short and net open-interest contracts by product and investor class. On 2026-09-24, TX foreign and trust net open interest were -77,031 and 72,864 contracts, exactly matching FinMind. The code merges the official row into local history only when its date matches FinMind's published-date baseline. On 2026-09-29, TAIFEX still returned 2026-09-24 while FinMind/local history reached 2026-09-29, so the code correctly used FinMind instead of presenting an older date as current.

`http_get_json` no longer appends a bare `?` for requests with no parameters. TAIFEX's OpenAPI endpoint returns Swagger HTML when any query string is present, so the empty query had to be removed for JSON parsing and official-source integration to work.

## Confirmed by direct comparison (2026-09-27)

FinMind's raw `TaiwanStockPrice` fields matched the corresponding official daily-market records exactly for these samples:

| Code | Market | Date type | Date |
| --- | --- | --- | --- |
| 2330 | TWSE | Normal trading day | 2026-09-24 |
| 0050 | TWSE | Normal trading day | 2026-09-24 |
| 6488 | TPEx | Normal trading day | 2026-09-24 |
| 2330 | TWSE | Ex-dividend day | 2026-09-16 |
| 0050 | TWSE ETF | Ex-dividend day | 2026-07-21 |

The matching fields were: date, open, high, low, close, price change, trading shares, trading amount, and number of trades.

For 2330, the TWSE dividend OpenAPI's cash-dividend-per-share values also matched FinMind (including 7.00000137 and 6.00003573). The official TWSE distribution endpoint does not contain the actual ex-dividend date or payment date. TPEx's ex-right pre-announcement endpoint contains the planned ex-date and dividend amounts but not the payment date and only covers upcoming announcements; its daily calculation endpoint is a current-day result, not the complete event history. Keep FinMind for the complete dividend record unless an official source can supply all four fields for the listed, OTC, and ETF universes.

## Safe first implementation

Replace the daily-price primary source in `scripts/fetch_data.py`'s `fetch_price` function:

- TWSE official source for listed stocks and ETFs.
- TPEx official source for OTC stocks and ETFs.
- FinMind retained as a fallback when an official request fails, and for any historical backfill not available from the chosen official endpoint.

Keep the existing output contract unchanged: `price` contains `t`, `o`, `h`, `l`, `c`, and `v`; `v` means trading shares, not trading amount. FinMind also exposes `Trading_money` and `Trading_turnover`, but the generated stock JSON does not currently store them.

The current tracked universe is 252 stocks plus 88 ETFs (340 total). Replacing the daily per-code price requests can remove about 340 FinMind requests per update run, roughly half of the current daily request load.

## Do not switch without further validation

- Emerging individual institutional flows / `retail_flow`: locate and validate an official source before switching it. The current code combines `Foreign_Investor` and `Foreign_Dealer_Self` into `foreign_lots`.
- Dividends: official data currently lacks complete actual ex-dividend date and payment-date history across listed companies, OTC companies, and ETFs; keep FinMind.
- EPS: do not switch yet. Official current statements cover 250 of 251 tracked TWSE/TPEx stocks, but report cumulative EPS, whereas the site stores single-quarter EPS. Of 229 symbols that had enough current FinMind quarter rows to compare, 29 differed after accumulating the FinMind values (likely restatements and rounding/reporting differences); 21 financial-industry symbols had no usable current FinMind quarter sequence. A source that supplies historical/restated quarterly figures, or an explicit restatement policy, is required before replacement.
- Stock splits: validate before replacing because the derived adjusted-price series depends on them.
- Futures institutional positions: TAIFEX is integrated with a same-date guard; FinMind remains the fallback while TAIFEX lags the published-date baseline.
- TPEx special-day validation: normal-day field matching is confirmed for 6488; obtain a documented/current TPEx historical endpoint or official downloadable CSV to test an ex-dividend day.

## Remaining-source review (2026-09-29)

The current TWSE and TPEx public OpenAPI specifications do not expose an evident full-market historical stock-split / par-value-change event endpoint. TWSE does publish par-value-change announcements through MOPS, but announcements are not yet validated as a complete, machine-readable event history across TWSE, TPEx, and ETFs. Since these events feed adjusted prices, `TaiwanStockSplitPrice` remains in use rather than risking missing adjustment factors.

The stock-name map is still fetched weekly from FinMind (`TaiwanStockInfo`). This is one request per seven days, so its maximum savings are negligible compared with daily prices; switching it would need a verified combined listed/OTC/ETF source and a field-coverage check. No source replacement was made for names in this pass.

The current official-source wins are daily prices (about 340 per-code calls avoided per run), individual listed/OTC institutional flows (about 334 calls avoided per run), monthly revenue, listed-market aggregate institutional money, and conditionally current-date TX futures open interest. FinMind remains intentionally active for dividends, EPS, stock splits, six emerging-stock institutional flows, historical/new-symbol fallbacks, and when TAIFEX has not published the baseline date. Estimated daily savings are therefore about 674 per-code FinMind calls, with actual request count dependent on cache freshness and endpoint availability.

## Implementation guardrails

1. Assign exactly one primary source per generated field; do not silently mix transaction scopes.
2. Preserve the existing cache, latest-published-date checks, stale-data fallback, and output JSON schema.
3. Add source-specific normalizers and comparison tests before changing a field's primary source.
4. Run a representative comparison set: listed stock, listed ETF, OTC stock, OTC ETF, ex-dividend day, zero-lot/after-hours day, and a foreign-currency ETF (where a lot may not equal 1,000 units).
