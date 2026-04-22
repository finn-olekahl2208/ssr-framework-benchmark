#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Statistische Analyse der Benchmark-Ergebnisse
Bachelorthesis: Evaluierung eines modernen SSR-Frameworks
Autor: Finn-Ole Kahl

Methodik:
  - Deskriptive Statistik: Median, IQR, SD, Min, Max
  - Inferenzstatistik: Mann-Whitney-U-Test (alpha = 0.05)
  - Effektstärke: Rank-biserial correlation (r)
  - Normalitätstest: Shapiro-Wilk
  - Konfidenzintervalle: Bootstrap 95%-CI für Median-Differenzen

Ausgabe:
  - Deskriptive Tabellen (CSV) pro Profil
  - Inferenzstatistik-Tabellen (CSV) pro Profil und Szenario-Paar
  - Warm-Cache-Analyse (CSV)
"""

import sys
import os
import warnings
from itertools import combinations

import numpy as np
import pandas as pd
from scipy import stats

warnings.filterwarnings("ignore", category=FutureWarning)

# -- Konfiguration --------------------------------------------------------

ALPHA = 0.05
BOOTSTRAP_ITERATIONS = 10000
RANDOM_SEED = 42

# -- Metriken-Definitionen ------------------------------------------------

# Cold-Cache-Metriken
METRICS = {
    "lh_fcpMs": {
        "label": "First Contentful Paint",
        "unit": "ms",
        "hypothesis": "H1/H2",
        "lower_is_better": True,
    },
    "lh_lcpMs": {
        "label": "Largest Contentful Paint",
        "unit": "ms",
        "hypothesis": "H1",
        "lower_is_better": True,
    },
    "lh_ttiMs": {
        "label": "Time to Interactive",
        "unit": "ms",
        "hypothesis": "H2",
        "lower_is_better": True,
    },
    "lh_tbtMs": {
        "label": "Total Blocking Time",
        "unit": "ms",
        "hypothesis": "H2",
        "lower_is_better": True,
    },
    "lh_cls": {
        "label": "Cumulative Layout Shift",
        "unit": "",
        "hypothesis": "H1",
        "lower_is_better": True,
    },
    "lh_speedIndex": {
        "label": "Speed Index",
        "unit": "ms",
        "hypothesis": "H1",
        "lower_is_better": True,
    },
    "scriptDurationMs": {
        "label": "JS-Ausführungszeit",
        "unit": "ms",
        "hypothesis": "H2",
        "lower_is_better": True,
    },
    "jsHeapUsedSizeMB": {
        "label": "JS Heap (Used)",
        "unit": "MB",
        "hypothesis": "H2",
        "lower_is_better": True,
    },
    "totalPayloadKB": {
        "label": "Payload (gesamt)",
        "unit": "KB",
        "hypothesis": "H1",
        "lower_is_better": True,
    },
    "totalRequests": {
        "label": "HTTP-Requests",
        "unit": "",
        "hypothesis": "H1",
        "lower_is_better": True,
    },
    "htmlDocumentKB": {
        "label": "HTML-Dokument",
        "unit": "KB",
        "hypothesis": "H1",
        "lower_is_better": True,
    },
    "jsPayloadKB": {
        "label": "JS-Payload",
        "unit": "KB",
        "hypothesis": "H2",
        "lower_is_better": True,
    },
    "apiPayloadKB": {
        "label": "API-Payload (Fetch+XHR)",
        "unit": "KB",
        "hypothesis": "H1",
        "lower_is_better": True,
    },
    "cssPayloadKB": {
        "label": "CSS-Payload",
        "unit": "KB",
        "hypothesis": "H1",
        "lower_is_better": True,
    },
    "staticAssetKB": {
        "label": "Statische Assets",
        "unit": "KB",
        "hypothesis": "H1",
        "lower_is_better": True,
    },
    "ttfbMs": {
        "label": "Time to First Byte",
        "unit": "ms",
        "hypothesis": "H1",
        "lower_is_better": True,
    },
    "domContentLoadedMs": {
        "label": "DOMContentLoaded",
        "unit": "ms",
        "hypothesis": "H2",
        "lower_is_better": True,
    },
    "domInteractiveMs": {
        "label": "DOM Interactive",
        "unit": "ms",
        "hypothesis": "H2",
        "lower_is_better": True,
    },
    "lh_performanceScore": {
        "label": "Lighthouse Score",
        "unit": "",
        "hypothesis": "H1",
        "lower_is_better": False,
    },
}

# Warm-Cache-Metriken
WARM_CACHE_METRICS = {
    "warmPayloadKB": {
        "label": "Warm-Cache Payload (gesamt)",
        "unit": "KB",
        "hypothesis": "H1",
        "lower_is_better": True,
    },
    "warmNetworkPayloadKB": {
        "label": "Warm-Cache Netzwerk-Payload",
        "unit": "KB",
        "hypothesis": "H1",
        "lower_is_better": True,
    },
    "warmRequests": {
        "label": "Warm-Cache Requests (gesamt)",
        "unit": "",
        "hypothesis": "H1",
        "lower_is_better": True,
    },
    "warmNetworkRequests": {
        "label": "Warm-Cache Netzwerk-Requests",
        "unit": "",
        "hypothesis": "H1",
        "lower_is_better": True,
    },
    "warmCachedRequests": {
        "label": "Gecachte Requests",
        "unit": "",
        "hypothesis": "H1",
        "lower_is_better": False,
    },
    "cacheHitRate": {
        "label": "Cache-Hit-Rate",
        "unit": "%",
        "hypothesis": "H1",
        "lower_is_better": False,
    },
    "payloadReductionPct": {
        "label": "Payload-Reduktion (Cold->Warm)",
        "unit": "%",
        "hypothesis": "H1",
        "lower_is_better": False,
    },
    "warmNavigationMs": {
        "label": "Warm-Cache Navigationszeit",
        "unit": "ms",
        "hypothesis": "H1",
        "lower_is_better": True,
    },
    "warmTtfbMs": {
        "label": "Warm-Cache TTFB",
        "unit": "ms",
        "hypothesis": "H1",
        "lower_is_better": True,
    },
    "warmDomContentLoadedMs": {
        "label": "Warm-Cache DOMContentLoaded",
        "unit": "ms",
        "hypothesis": "H2",
        "lower_is_better": True,
    },
    "warm_htmlDocumentKB": {
        "label": "Warm HTML-Dokument",
        "unit": "KB",
        "hypothesis": "H1",
        "lower_is_better": True,
    },
    "warm_jsPayloadKB": {
        "label": "Warm JS-Payload",
        "unit": "KB",
        "hypothesis": "H2",
        "lower_is_better": True,
    },
    "warm_apiPayloadKB": {
        "label": "Warm API-Payload",
        "unit": "KB",
        "hypothesis": "H1",
        "lower_is_better": True,
    },
}


# -- Hilfsfunktionen ------------------------------------------------------


def rank_biserial_r(u_stat, n1, n2):
    """Rank-biserial Korrelation als Effektstärke für Mann-Whitney-U."""
    return 1 - (2 * u_stat) / (n1 * n2)


def interpret_effect_size(r):
    """Interpretation der Effektstärke nach Cohen."""
    abs_r = abs(r)
    if abs_r < 0.1:
        return "vernachlässigbar"
    elif abs_r < 0.3:
        return "klein"
    elif abs_r < 0.5:
        return "mittel"
    else:
        return "gross"


def bootstrap_median_diff_ci(group_a, group_b,
                              n_iterations=BOOTSTRAP_ITERATIONS,
                              ci=0.95, seed=RANDOM_SEED):
    """Bootstrap-Konfidenzintervall für die Differenz der Mediane."""
    rng = np.random.RandomState(seed)
    diffs = np.empty(n_iterations)
    for i in range(n_iterations):
        sample_a = rng.choice(group_a, size=len(group_a), replace=True)
        sample_b = rng.choice(group_b, size=len(group_b), replace=True)
        diffs[i] = np.median(sample_a) - np.median(sample_b)
    alpha_half = (1 - ci) / 2
    lower = np.percentile(diffs, alpha_half * 100)
    upper = np.percentile(diffs, (1 - alpha_half) * 100)
    return lower, upper, np.median(diffs)


def descriptive_stats(series):
    """Berechnet deskriptive Statistiken für eine Messreihe."""
    clean = series.dropna()
    if len(clean) == 0:
        return {k: np.nan for k in [
            "n", "mean", "median", "std", "iqr",
            "q25", "q75", "min", "max", "cv"
        ]}
    return {
        "n": len(clean),
        "mean": clean.mean(),
        "median": clean.median(),
        "std": clean.std(),
        "iqr": clean.quantile(0.75) - clean.quantile(0.25),
        "q25": clean.quantile(0.25),
        "q75": clean.quantile(0.75),
        "min": clean.min(),
        "max": clean.max(),
        "cv": (clean.std() / clean.mean() * 100)
              if clean.mean() != 0 else np.nan,
    }


def check_normality(series, alpha=ALPHA):
    """Shapiro-Wilk-Test auf Normalverteilung."""
    clean = series.dropna()
    if len(clean) < 3:
        return np.nan, False
    stat, p = stats.shapiro(clean)
    return p, p > alpha


def run_mann_whitney(data_a, data_b, meta, label_a, label_b):
    """Mann-Whitney-U-Test für ein Metrik-Paar."""
    if len(data_a) < 5 or len(data_b) < 5:
        return None

    u_stat, p_value = stats.mannwhitneyu(
        data_a, data_b, alternative="two-sided"
    )
    r = rank_biserial_r(u_stat, len(data_a), len(data_b))
    effect_interpretation = interpret_effect_size(r)

    median_a = np.median(data_a)
    median_b = np.median(data_b)
    diff_abs = median_a - median_b
    diff_pct = ((median_a - median_b) / median_b * 100
                if median_b != 0 else np.nan)

    if meta["lower_is_better"]:
        favorable = label_a if median_a < median_b else label_b
    else:
        favorable = label_a if median_a > median_b else label_b

    ci_lower, ci_upper, _ = bootstrap_median_diff_ci(data_a, data_b)
    significant = p_value < ALPHA

    return {
        "Metrik": meta["label"],
        "Hypothese": meta["hypothesis"],
        f"Median {label_a}": round(median_a, 2),
        f"Median {label_b}": round(median_b, 2),
        "Differenz (abs)": round(diff_abs, 2),
        "Differenz (%)": round(diff_pct, 1),
        "U-Statistik": round(u_stat, 1),
        "p-Wert": f"{p_value:.6f}",
        "Signifikant": "Ja" if significant else "Nein",
        "Effektstärke (r)": round(r, 3),
        "Effekt": effect_interpretation,
        "95%-CI unten": round(ci_lower, 2),
        "95%-CI oben": round(ci_upper, 2),
        "Vorteil": favorable,
    }


def get_scenario_label(df, scenario_key):
    """Holt das Label für ein Szenario."""
    sub = df[df["scenario"] == scenario_key]
    if "scenarioLabel" in sub.columns and len(sub) > 0:
        return sub["scenarioLabel"].iloc[0]
    return scenario_key


# -- Daten laden -----------------------------------------------------------


def load_data(result_dir):
    """Lädt Cold-Cache- und Warm-Cache-Daten."""
    csv_path = os.path.join(result_dir, "combined_all_scenarios.csv")
    if not os.path.exists(csv_path):
        raise FileNotFoundError(f"Datei nicht gefunden: {csv_path}")
    df = pd.read_csv(csv_path)
    print(f"Cold-Cache: {len(df)} Datensätze aus {csv_path}")

    scenarios = df["scenario"].unique().tolist()
    print(f"  Szenarien: {scenarios}")

    if "throttlingProfile" in df.columns:
        profiles = df["throttlingProfile"].unique().tolist()
        print(f"  Throttling-Profile: {profiles}")
    else:
        profiles = [None]

    available_metrics = [c for c in df.columns if c in METRICS]
    print(f"  Cold-Cache-Metriken: {len(available_metrics)} verfügbar")

    warm_csv_path = os.path.join(result_dir, "combined_warm_cache.csv")
    df_warm = None
    if os.path.exists(warm_csv_path):
        df_warm = pd.read_csv(warm_csv_path)
        print(f"Warm-Cache: {len(df_warm)} Datensätze")
    else:
        print("  Warm-Cache: Keine Daten gefunden")

    return df, df_warm


# -- Analyse-Kernfunktionen ------------------------------------------------


def analyze_descriptive(profile_df, metrics_dict, scenario_labels):
    """Deskriptive Statistik für alle Szenarien und Metriken."""
    rows = []
    for metric_key, meta in metrics_dict.items():
        if metric_key not in profile_df.columns:
            continue
        row = {
            "Metrik": meta["label"],
            "Einheit": meta["unit"],
            "Hypothese": meta["hypothesis"],
        }
        for scenario_key, label in scenario_labels.items():
            s_df = profile_df[profile_df["scenario"] == scenario_key]
            if len(s_df) == 0:
                continue
            s = descriptive_stats(s_df[metric_key])
            row[f"{label} n"] = int(s["n"])
            row[f"{label} Median"] = round(s["median"], 2)
            row[f"{label} IQR"] = round(s["iqr"], 2)
            row[f"{label} Mean"] = round(s["mean"], 2)
            row[f"{label} SD"] = round(s["std"], 2)
            row[f"{label} Min"] = round(s["min"], 2)
            row[f"{label} Max"] = round(s["max"], 2)
            row[f"{label} CV%"] = (
                round(s["cv"], 1) if not np.isnan(s["cv"]) else ""
            )
        rows.append(row)
    return pd.DataFrame(rows)


def analyze_normality(profile_df, metrics_dict, scenario_labels):
    """Shapiro-Wilk-Tests für alle Szenarien."""
    rows = []
    for metric_key, meta in metrics_dict.items():
        if metric_key not in profile_df.columns:
            continue
        row = {"Metrik": meta["label"]}
        for scenario_key, label in scenario_labels.items():
            s_df = profile_df[profile_df["scenario"] == scenario_key]
            if len(s_df) == 0:
                continue
            p_val, is_normal = check_normality(s_df[metric_key])
            row[f"{label} p-Wert"] = (
                round(p_val, 4) if not np.isnan(p_val) else "N/A"
            )
            row[f"{label} normalverteilt"] = "Ja" if is_normal else "Nein"
        rows.append(row)
    return pd.DataFrame(rows)


def analyze_inferential(profile_df, metrics_dict, scenario_a, scenario_b,
                         label_a, label_b):
    """Mann-Whitney-U-Tests für ein Szenario-Paar."""
    rows = []
    df_a = profile_df[profile_df["scenario"] == scenario_a]
    df_b = profile_df[profile_df["scenario"] == scenario_b]

    for metric_key, meta in metrics_dict.items():
        if metric_key not in profile_df.columns:
            continue
        data_a = df_a[metric_key].dropna().values
        data_b = df_b[metric_key].dropna().values
        result = run_mann_whitney(data_a, data_b, meta, label_a, label_b)
        if result is None:
            continue
        rows.append(result)

    return pd.DataFrame(rows)


# -- Hauptanalyse ----------------------------------------------------------


def run_analysis(df, df_warm, output_dir):
    """Führt die komplette statistische Analyse durch."""
    scenarios = df["scenario"].unique().tolist()
    scenario_labels = {s: get_scenario_label(df, s) for s in scenarios}

    # Vergleichspaare: Prototyp gegen jede Baseline
    prototype_key = next(
        (s for s in scenarios if "prototype" in s.lower()), scenarios[0]
    )
    scenario_pairs = [
        (prototype_key, s) for s in scenarios if s != prototype_key
    ]

    print(f"\n  Szenarien: {list(scenario_labels.values())}")
    print(f"  Vergleichspaare: {len(scenario_pairs)}")

    if "throttlingProfile" in df.columns:
        profile_keys = df["throttlingProfile"].unique().tolist()
    else:
        profile_keys = [None]

    # Sammler für kombinierte CSVs
    all_desc, all_norm, all_infer = [], [], []
    all_warm_desc, all_warm_infer = [], []

    for profile_key in profile_keys:
        if profile_key is not None:
            profile_df = df[
                df["throttlingProfile"] == profile_key
            ].copy()
            profile_label = (
                profile_df["throttlingLabel"].iloc[0]
                if "throttlingLabel" in profile_df.columns
                else profile_key
            )
            file_prefix = f"{profile_key}_"
            warm_profile_df = (
                df_warm[df_warm["throttlingProfile"] == profile_key].copy()
                if df_warm is not None else None
            )
        else:
            profile_df = df.copy()
            profile_label = "Standard"
            file_prefix = ""
            warm_profile_df = df_warm

        print(f"\n  PROFIL: {profile_label}")

        # 1. Deskriptive Statistik
        desc_df = analyze_descriptive(profile_df, METRICS, scenario_labels)
        desc_df.insert(0, "Profil", profile_label)
        desc_df.insert(1, "ProfilKey", profile_key or "")
        desc_df.to_csv(
            os.path.join(
                output_dir,
                f"{file_prefix}descriptive_statistics.csv",
            ),
            index=False,
        )
        all_desc.append(desc_df)

        # 2. Normalitätstests
        norm_df = analyze_normality(profile_df, METRICS, scenario_labels)
        norm_df.insert(0, "Profil", profile_label)
        norm_df.insert(1, "ProfilKey", profile_key or "")
        norm_df.to_csv(
            os.path.join(
                output_dir, f"{file_prefix}normality_tests.csv"
            ),
            index=False,
        )
        all_norm.append(norm_df)

        # 3. Inferenzstatistik (paarweise Vergleiche)
        for scenario_a, scenario_b in scenario_pairs:
            label_a = scenario_labels[scenario_a]
            label_b = scenario_labels[scenario_b]
            pair_id = f"{scenario_a}_vs_{scenario_b}"

            infer_df = analyze_inferential(
                profile_df, METRICS,
                scenario_a, scenario_b, label_a, label_b,
            )
            if len(infer_df) > 0:
                infer_df.insert(0, "Profil", profile_label)
                infer_df.insert(1, "ProfilKey", profile_key or "")
                infer_df.insert(2, "Vergleich", pair_id)
                infer_df.to_csv(
                    os.path.join(
                        output_dir,
                        f"{file_prefix}{pair_id}_inferential.csv",
                    ),
                    index=False,
                )
                all_infer.append(infer_df)

        # 4. Warm-Cache-Analyse
        if warm_profile_df is not None and len(warm_profile_df) > 0:
            warm_desc_df = analyze_descriptive(
                warm_profile_df, WARM_CACHE_METRICS, scenario_labels
            )
            warm_desc_df.insert(0, "Profil", profile_label)
            warm_desc_df.insert(1, "ProfilKey", profile_key or "")
            warm_desc_df.to_csv(
                os.path.join(
                    output_dir,
                    f"{file_prefix}warm_cache_descriptive.csv",
                ),
                index=False,
            )
            all_warm_desc.append(warm_desc_df)

            for scenario_a, scenario_b in scenario_pairs:
                label_a = scenario_labels[scenario_a]
                label_b = scenario_labels[scenario_b]
                pair_id = f"{scenario_a}_vs_{scenario_b}"

                wa = warm_profile_df[
                    warm_profile_df["scenario"] == scenario_a
                ]
                wb = warm_profile_df[
                    warm_profile_df["scenario"] == scenario_b
                ]
                if len(wa) == 0 or len(wb) == 0:
                    continue

                warm_infer_df = analyze_inferential(
                    warm_profile_df, WARM_CACHE_METRICS,
                    scenario_a, scenario_b, label_a, label_b,
                )
                if len(warm_infer_df) > 0:
                    warm_infer_df.insert(0, "Profil", profile_label)
                    warm_infer_df.insert(1, "ProfilKey", profile_key or "")
                    warm_infer_df.insert(2, "Vergleich", pair_id)
                    warm_infer_df.to_csv(
                        os.path.join(
                            output_dir,
                            f"{file_prefix}{pair_id}"
                            "_warm_cache_inferential.csv",
                        ),
                        index=False,
                    )
                    all_warm_infer.append(warm_infer_df)

    # Kombinierte CSVs
    if all_desc:
        pd.concat(all_desc, ignore_index=True).to_csv(
            os.path.join(output_dir, "descriptive_statistics.csv"),
            index=False,
        )
    if all_norm:
        pd.concat(all_norm, ignore_index=True).to_csv(
            os.path.join(output_dir, "normality_tests.csv"), index=False
        )
    if all_infer:
        pd.concat(all_infer, ignore_index=True).to_csv(
            os.path.join(output_dir, "inferential_statistics.csv"),
            index=False,
        )
    if all_warm_desc:
        pd.concat(all_warm_desc, ignore_index=True).to_csv(
            os.path.join(output_dir, "warm_cache_descriptive.csv"),
            index=False,
        )
    if all_warm_infer:
        pd.concat(all_warm_infer, ignore_index=True).to_csv(
            os.path.join(output_dir, "warm_cache_inferential.csv"),
            index=False,
        )

    print(f"\nAlle Ergebnisse gespeichert in: {output_dir}")


# -- Einstiegspunkt --------------------------------------------------------

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Verwendung: python3 analyze.py <ergebnis-verzeichnis>")
        sys.exit(1)

    result_dir = sys.argv[1]
    if not os.path.isdir(result_dir):
        print(f"Fehler: Verzeichnis nicht gefunden: {result_dir}")
        sys.exit(1)

    print("Statistische Analyse -- Bachelorthesis Finn-Ole Kahl")
    print()

    np.random.seed(RANDOM_SEED)
    df, df_warm = load_data(result_dir)
    run_analysis(df, df_warm, result_dir)