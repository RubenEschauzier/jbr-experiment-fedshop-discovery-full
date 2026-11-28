# My Experiment

This experiment was created with [jbr](https://github.com/rubensworks/jbr.js).

## Requirements

* [Node.js](https://nodejs.org/en/) _(1.12 or higher)_

## Installation

Before this experiment can be used, its dependencies must be downloaded first:

```bash
$ npm install
```

## Usage

Generate the dataset and queries:

```bash
$ npm run jbr -- prepare
```

Run the experiment locally:

```bash
$ npm run jbr -- run
```

The `output/` directory will now contain all experiment results.

## Usage if jbr is installed globally

If [jbr is installed globally](https://github.com/rubensworks/jbr.js/tree/master/packages/jbr#installation),
you can prepare and run this experiment as follows:

```bash
$ jbr prepare
$ jbr run
```

## The federation-size axis

This experiment is axis A2 (federation size) of the evaluation plan
(`experiments-micro-benchmarks/EVALUATION-PLAN.md`). It varies the number of **discoverable** pods around the
default point of the full experiment (`jbr-experiment-fedshop-discovery-full`, branch `master`). Every pod keeps its
size, and the **known federation stays fixed: 10 known shops and 10 known review sites at every scale**. Otherwise
it is the same experiment as the coverage axis (branch `experiment/vary-endpoint-fraction`): the same overrides,
configurations, Dockerfiles, 3 measured replications + 1 warm-up, and instance 0 of every template.

| | x0.5 | x1 (default point) | x2 | x4 (optional) |
|---|---|---|---|---|
| brands (`brands.count`) | 200 | 400 | 800 | 1,600 |
| products (`brands.products`) | 15,000 | 30,000 | 60,000 | 120,000 |
| shops (`members.shops`): known + discoverable | 10 + 5 | 10 + 10 | 10 + 20 | 10 + 40 |
| review sites (`members.review_sites`): known + discoverable | 10 + 5 | 10 + 10 | 10 + 20 | 10 + 40 |
| `known.ratio` (set so that 10 of each stay known) | 2/3 | 1/2 | 1/3 | 1/5 |
| products shops and review sites deal in (`members.pool`) | 7,500 | 10,000 | 15,000 | 25,000 |
| query timeout / runner fallback | 180 s / 300 s | 180 s / 300 s | 360 s / 480 s | 720 s / 840 s |
| `virtuosoBuffersMain` (the discoverable endpoints) | 340,000 | 340,000 | 680,000 | 1,360,000 |
| memory needed (estimate) | 13.7 GiB | 13.7 GiB | 16.7 GiB | 22.7 GiB |

What stays the same per pod:
* **products per brand** (75 on average): `brands.products` scales with `brands.count`;
* **shops and review sites per product**: `members.pool` scales with the shops and review sites together;
* **offers per shop, reviews per review site, reviews per reviewer**: not scaled. The reviewers (discoverable pods)
  grow with the review sites;
* **the known federation**: 10 + 10 members of the same size. Their contents still differ per scale, as the brands'
  catalog that their offers and reviews point into grows.

x1 is the default point itself: its overrides are byte-identical to `input/discovery-overrides.yaml`. The known
virtuoso (`virtuosoBuffersKnown`, 85,000) is not scaled, as the known federation does not grow.

**Caveat:** brand sizes follow a Zipf distribution over the brands. Their mean stays 75, but the largest brand grows
with the federation: 890, 1,380, 2,147 and 3,416 products at x0.5, x1, x2 and x4 (the smallest stays at 31–33).

### Running

```bash
setsid nohup ./run-vary.sh > output/run-vary.log 2>&1 < /dev/null &               # x0.5, x1, x2
setsid nohup ./run-vary.sh --include 4 > output/run-vary.log 2>&1 < /dev/null &   # and x4
npm run vary -- status                                                             # what is done, and x4's gate
```

**x4 is optional.** It runs only with `--include 4`, and only if x2 passes its gate: no combination failed more than
10% of its executions at x2 (an error, an answer incomplete against the reference, or a run into the timeout), and
the components' peak memory stayed below 80% of the host's. `--ignore-gate` runs it anyway. Complete points are
skipped, so `--include 4` after x2 runs only x4.

`run-vary.sh` removes every image the experiment uses on a fresh start, so prepare pulls the newest `:dev` generator
and engine images. Once a point is complete it keeps them, since every point must come from the same generator and
engine; `--fresh-images` removes them anyway. Progress is in `output/STATUS`.

## Configurations

The `alg` factor, in combination order (the same as in the full experiment):

| combination | `alg` | configuration | runs here |
|---|---|---|---|
| 0 | `derived` | derived full: traversal + composite sources (stars and chains of 2, star-first), whole composites | no |
| 1 | `derived-pattern-only` | pattern-only: traversal + every triple pattern delegated to the pod's endpoint (the baseline) | every point |
| 2 | `derived-extended-bound` | derived full + extended blocks + bound composites: the final configuration | every point |
| 3 | `adaptive-only` | traversal only: the same SteMs join and known federation members, no delegation (the floor) | no |
| 4 | `default` | traversal only with Comunica's default join, and known federation members: the reference for the SteMs join | no |

Every combination has its own Dockerfile, `input/dockerfiles/Dockerfile-client-<alg>`. They are the same except
that `derived-extended-bound` sets `DERIVED_EXTEND_BLOCKS=1` and `DERIVED_BOUND_COMPOSITES=1`. All use the engine
image `rubeneschauzier/comunica-query-sparql-link-traversal-solid-derived-resources:dev`.

## The script: `scripts/vary-scale.js`

```bash
npm run vary -- plan      # checks every point and writes into vary-n-pods.json what it means
npm run vary -- run       # [--include <labels>] [--force] [--ignore-gate] [--ignore-checks]
npm run vary -- status    # pods, data, failures and memory per point; whether the gates pass
npm test                  # unit tests of the script
```

The script is shared with the pod-size axis (A3, branch `experiment/vary-pod-size`, `vary-pod-size.json` with
`"perPod": "scaled"`); here `perPod` is left at `same`. Without a config argument it uses the one `vary-*.json` in
the directory.

`vary-n-pods.json`:

| Key | Default | |
|---|---|---|
| `scaled` | required | `{ "section.key": rule }`: the overrides a point scales by its scale s. `scale`: the base value times s. `discoverable` (`members.shops`, `members.review_sites` only): the known members stay, the others times s; `known.ratio` is then set per point so that the generator keeps exactly `known`. `members` (for `members.pool`): the base value times the growth of the shops and review sites together. A list of keys scales them all by `scale` |
| `known` | the base's | the known shops and review sites every point must have: `{ "shops": 10, "review_sites": 10 }` |
| `combinations` | all | the combinations every point runs, unless the point sets its own: values of the `alg` factor (or objects of factor values) |
| `points` | required | the points, smallest scale first. Each: `scale`; optionally `label` (default: the scale), `optional` (runs only with `--include <label>`), `gate` (`point`, `maxFailureShare` 0.1, `maxMemoryPercent` 80), `settings` (`jbr-experiment.json` settings for this point, by path, e.g. `hookSparqlEndpoint.queryTimeout`) and `combinations`. `plan` writes each point out in full: its overrides, its known members and its memory estimate |
| `baseOverrides` | `input/discovery-overrides.yaml` | the overrides every point starts from. It must set every key in `scaled`, and `known.ratio` (not `known.members`) |
| `jbr` | `["npm", "run", "jbr", "--"]` | how jbr is run in the experiment |
| `experiment` | the config's directory | the experiment |

**`plan` checks every point before anything runs** and refuses a point the generator would reject or that changes
the design. It recomputes, with the generator's own arithmetic:
* the brand sizes (`catalog.brand_sizes`): `brands.products` large enough for `count` and `min_products`, and at
  least `members.pool`;
* every market's pool (`markets.Markets`): enough products of the market's own brands;
* the known members (`publishing.choose_known`, per market, Python's rounding): exactly `known`;
* that every market has a shop and a review site.

It warns when a scaled value is not a whole number and was rounded.

**Per point, smallest scale first, `run`:**
1. skips a complete point (`output-<label>/point.json`), and an optional one without `--include`;
2. checks the gate, if any, against its point's `health.json`;
3. checks the memory estimate (Virtuoso's buffers × 8 KiB × 1.15, the engine's heap, 2 GiB for the rest) against
   the host, and warns when the disk may be too small (from the nearest complete point's generated bytes);
4. checks that every combination's `output/` is empty;
5. writes `input/discovery-overrides.scale-<label>.yaml` and points every combination's `jbr-experiment.json` at it,
   with the point's settings, until the point is done (then restores them, also after a failure or Ctrl+C);
6. `jbr prepare -f`: generates from scratch (the combinations share it) and reloads the databases;
7. checks the generator and engine images against the complete points', and the federation against the plan: as
   many shops, review sites and brands as the overrides give, and exactly `known` known shops and review sites. If
   either fails, nothing runs;
8. measures the federation and warns when a kind's triples per pod, or the known members' triples, moved more than
   20% from another point's, or when a template has no instance to run;
9. runs the point's combinations (`jbr run -c <i>`) and moves each one's `output/` to `output-<label>/combination_<i>/`;
10. writes `health.json`, then `point.json` last (it marks the point complete).

`--force` redoes a complete point; its earlier output is moved to `output-<label>.replaced-<time>/`, not removed.

**`output-<label>/`** holds, besides the combinations' output: `overrides.yaml`, `publishers.json`,
`workload-summary.csv`, `fedshop-discovery.json` (the generator image), `instances.csv` (per query instance run:
its kind, category, reference rows, the publishers it needs and a hash of its query; queries differ per point, so
compare within a point), `health.json` (per combination: executions, errors, incomplete answers, runs into the
timeout, the queries that failed, each component's peak memory) and `point.json` (the overrides and settings, the
measured federation per kind, the images, the warnings).

## Changes

**2026-11-26: created, from the full experiment of 2026-11-25 (`master`), for axis A2 of the evaluation plan.**
* The known federation is fixed (10 shops, 10 review sites); only the discoverable part scales. *Why:* the axis asks
  how delegation behaves as the part the engine must discover grows; the federation the query starts from stays.
* Combinations: pattern-only and the final configuration at every point. *Why:* the plan budgets two configurations
  per dataset; traversal only runs at the default point and at coverage 0 only.
* 3 measured replications + 1 warm-up (was 6 + 1), `queryInstances` `[0]` (was all), as in the coverage axis.
* x4 is optional and gated on x2. *Why:* the plan runs x4 only if x2 stays within the timeouts and memory.
* The query timeout and the main Virtuoso's buffers grow with the scale from x2. *Why:* the plan raises the timeout
  at x2 and x4; the buffers keep up with the discoverable data, so the endpoints do not slow down from paging.
* Dropped `run-full.sh` (replaced by `run-vary.sh`) and the unused `input/config-client.json`.
