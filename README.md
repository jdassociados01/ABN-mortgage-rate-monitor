# ABN Mortgage Rate Monitor

Public monitor for ABN AMRO mortgage renewal rates used in a personal Google Sheets dashboard.

## Configuration

The monitor requests the official ABN AMRO interest-rate calculator with:

- Product: `BUDGET`
- Mortgage type: `ANNUITAIR`
- Energy label: `A`
- Discount: `BANK_ACCOUNT` (Huisbankkorting)
- Tracked LTV band: `>65%-≤85%`

Tracked periods: Variable, 3 years, 5 years, 10 years, 20 years and 30 years.

## Data files

- `data/rates.csv` — six current rates, in the exact order above, expressed as percentage points (for example `4.05`). Designed for Google Sheets.
- `data/current.csv` — labeled current snapshot.
- `data/history.csv` — one row for each distinct ABN `renteblad` observed by the monitor.
- `data/latest.json` — source metadata and full parsed snapshot for traceability.
- `data/status.json` — last successful check timestamp.

## Google Sheets

If the period labels are already in `E2:E7`, put this in `F2` and format `F2:F7` as Percent with two decimals:

```gs
=ARRAYFORMULA(VALUE(SUBSTITUTE(IMPORTDATA("https://raw.githubusercontent.com/jdassociados01/ABN-mortgage-rate-monitor/main/data/rates.csv");".";","))/100)
```

For the historical table, use:

```gs
=IMPORTDATA("https://raw.githubusercontent.com/jdassociados01/ABN-mortgage-rate-monitor/main/data/history.csv")
```

## Automation

GitHub Actions runs the monitor daily and can also be started manually. The script opens ABN AMRO in a real Chromium browser and executes the rate request from the ABN page origin. This is intentional because direct server-to-server calls to the endpoint can be rejected by ABN's edge protection.

The workflow is fail-closed: if the response does not contain all expected periods and the selected LTV band, no rate files are replaced.

Source: official ABN AMRO mortgage interest-rate calculator at `https://hypotheken.abnamro.nl/interest-rates/app/?lang=nl`.
