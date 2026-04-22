# SSR-Framework Performance Benchmark -- Bachelorarbeit

Replication Package zur Bachelorarbeit *"Evaluierung eines modernen Rendering-Frameworks"* (Finn-Ole Kahl, 2026). Dieses Repository enthält die Benchmark-Suite, das statistische Auswertungsskript sowie die Rohdaten zu allen in der Arbeit berichteten Messergebnissen.

## Inhalt

```
.
├── benchmark/
│   ├── benchmark.mjs       # Messablauf: 3 Phasen × 50 Runs × 3 Profile × 3 Szenarien
│   ├── config.json          # Szenarien, Throttling-Profile, Messparameter
│   └── package.json
├── analyze/
│   ├── analyze.py           # Statistische Auswertung (deskriptiv + inferenz)
│   └── requirements.txt
├── results/
│   └── run_<timestamp>/     # Generierte CSVs + JSON pro Benchmark-Lauf
└── README.md
```

## Reproduktion der Ergebnisse

### Voraussetzungen

- Node.js >= 24 (getestet mit v24.13.0)
- Python >= 3.9
- macOS / Linux mit Headless-Chrome-Unterstützung
- Netzwerkzugang zur Test-Umgebung (`develop.otto.de`) -- nur intern erreichbar

### Statistische Auswertung reproduzieren (extern möglich)

```bash
cd analyze
pip install -r requirements.txt
python3 analyze.py ../results/run_<timestamp>
```

Das Skript erwartet ein Ergebnisverzeichnis mit `combined_all_scenarios.csv` (und optional `combined_warm_cache.csv`). Die generierten CSVs werden im selben Verzeichnis abgelegt.

### Benchmark-Lauf neu ausführen (intern, OTTO-Netz)

```bash
cd benchmark
npm install
node benchmark.mjs
```

Konfiguration (siehe `config.json`): 50 Runs pro Szenario, 3 Warmup-Runs (verworfen), 2.000 ms Cooldown, Cold-Cache pro Run. Ergebnisse landen unter `results/run_<timestamp>/`.

## Methodik

Quantitative Hypothesenprüfung (H1: Ladeperformance, H2: Interaktivität) mittels:

- **Deskriptive Statistik:** Median, IQR, SD, Min, Max, CV%
- **Normalitätstest:** Shapiro-Wilk je Messreihe (alpha = 0,05)
- **Hypothesentest:** Mann-Whitney-U, zweiseitig
- **Effektstärke:** Rank-biserial Korrelation r
- **Konfidenzintervalle:** Bootstrap-95%-KI für Mediandifferenzen (B = 10.000, Seed = 42)

## Test-Szenarien

| Szenario | Bezeichnung | URL |
|----------|-------------|-----|
| `prototype` | Kestrel-Kit (Prototyp) | `develop.otto.de/gefunden-auf-otto/` |
| `baseline` | Legacy (Baseline 1) | `develop.otto.de/customer-contact-details-invoiceaddress/change` |
| `baseline2` | Legacy (Baseline 2) | `develop.otto.de/contact-contact/support` |

## Throttling-Profile (CDP)

| Profil | Download | Upload | Latenz |
|--------|----------|--------|--------|
| `cable` | 5.000 KB/s | 5.000 KB/s | 28 ms |
| `4g` | 4.000 KB/s | 3.000 KB/s | 170 ms |
| `worst_case` | 50 KB/s | 50 KB/s | 400 ms |

## Generierte Dateien pro Lauf

**Von `benchmark.mjs`:**
- `{profil}_{szenario}_raw.csv` -- Cold-Cache-Rohdaten (CDP + Lighthouse)
- `{profil}_{szenario}_network_breakdown.csv` -- Netzwerk nach Ressourcentyp
- `{profil}_{szenario}_warm_cache.csv` -- Warm-Cache-Rohdaten
- `combined_all_scenarios.csv` -- Alle Cold-Cache-Daten kombiniert
- `combined_warm_cache.csv` -- Alle Warm-Cache-Daten kombiniert
- `results_complete.json` -- Kompletter Roh-Output

**Von `analyze.py`:**
- `{profil}_descriptive_statistics.csv` -- Deskriptive Statistik pro Profil
- `{profil}_normality_tests.csv` -- Shapiro-Wilk-Tests pro Profil
- `{profil}_{paar}_inferential.csv` -- Mann-Whitney-U pro Vergleichspaar
- `{profil}_warm_cache_descriptive.csv` -- Deskriptive Statistik Warm-Cache
- `{profil}_{paar}_warm_cache_inferential.csv` -- Mann-Whitney-U Warm-Cache
- Kombinierte Varianten ohne Profil-Präfix (alle Profile zusammen)

## Kontakt

Finn-Ole Kahl - finn-ole.kahl@otto.de