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

Generate combinations to use all latest versions:
```bash
$ npm run jbr -- generate-combinations
```

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

## The coverage axis

This experiment is axis A1 (coverage) of the evaluation plan
(`experiments-micro-benchmarks/EVALUATION-PLAN.md`). It varies the share f of the discoverable endpoints around the
default point of the full experiment (`jbr-experiment-fedshop-discovery-full`, branch `master`), and is otherwise
the same experiment: the same overrides, configurations, Dockerfiles and combinations. It differs in:

| | full experiment (the default point) | this experiment |
|---|---|---|
| `services.brands`, `.shops`, `.review_sites` | 1.0 | f ∈ {0, 0.25, 0.5, 0.75, 1}, written per fraction by the script |
| combinations run | all 5 | pattern-only and the final configuration; at f = 0 also traversal only |
| `queryRunnerReplication` | 6 (+ 1 warm-up) | 3 (+ 1 warm-up) |
| `queryInstances` | all | `[0]`: instance 0 of every template |

f = 1 is the default point's coverage. It is run here too, so that every point of the axis has the same queries,
replications and generator, and the script checks its data against the other fractions'. At f = 0 the known members (half the shops and review
sites) still have their endpoint, so f = 0 is "known federation + traversal", not pure traversal.

```bash
setsid nohup ./run-vary.sh > output/run-vary.log 2>&1 < /dev/null &
```

`run-vary.sh` removes every image the experiment uses (so the first prepare pulls the newest `:dev` generator and
engine images and rebuilds the client images on them), generates the combinations and runs every fraction with
`npm run vary -- run`. The images are removed only once: all fractions must come from the same generator, or the
fingerprint check stops the run. Progress is in `output/STATUS`.

## Configurations

The `alg` factor, in combination order (the same as in the full experiment):

| combination | `alg` | configuration | runs here |
|---|---|---|---|
| 0 | `derived` | derived full: traversal + composite sources (stars and chains of 2, star-first), whole composites | no |
| 1 | `derived-pattern-only` | pattern-only: traversal + every triple pattern delegated to the pod's endpoint (the baseline) | every fraction |
| 2 | `derived-extended-bound` | derived full + extended blocks + bound composites: the final configuration | every fraction |
| 3 | `adaptive-only` | traversal only: the same SteMs join and known federation members, no delegation (the floor) | f = 0 |
| 4 | `default` | traversal only with Comunica's default join, and known federation members: the reference for the SteMs join | no |

Every combination has its own Dockerfile, `input/dockerfiles/Dockerfile-client-<alg>`. They are the same except
that `derived-extended-bound` sets `DERIVED_EXTEND_BLOCKS=1` and `DERIVED_BOUND_COMPOSITES=1`. All use the engine
image `rubeneschauzier/comunica-query-sparql-link-traversal-solid-derived-resources:dev`.

If the full run does not confirm the final configuration, the plan falls back to derived full: replace
`derived-extended-bound` by `derived` in `combinations` of `vary-endpoint-fraction.json`.

## Varying the fraction of publishers with an endpoint

`scripts/vary-endpoint-fraction.js` runs the experiment once per fraction of the discoverable publishers with a SPARQL endpoint. Every fraction needs its own generation. The data and queries stay the same, and the script checks that they do. The combinations share one generation (`commonGenerated` in `jbr-combinations.json`), so every fraction is generated once and run for the combinations it selects.

```bash
npm run vary -- plan          # writes into vary-endpoint-fraction.json what each fraction means
npm run vary -- run           # [--force] redoes fractions that are already done
```

The generator image (`generatorImage`) must support the `services` section of `input/discovery-overrides.yaml`. Images from before it ignore the section and give every fraction the same endpoints, so check `generatorImage` before a run.

Which publishers have an endpoint is the generator's `services` section. Known shops and review sites always have one, and the taxonomy and reviewers never do. For brands, discovered shops and discovered review sites, `services.select` chooses how:

- `largest`: the largest publishers of a kind (by products, offers or reviews), the given share of their number. Brand sizes follow a Zipf distribution, so a share of the brands holds a larger share of the products.
- `data`: the publishers in a seeded random order, as many as it takes to hold the given share of the kind's products, offers or reviews. This overshoots by less than one publisher. A larger share takes a longer prefix of the same order, so it keeps every endpoint of a smaller one.

`vary-endpoint-fraction.json`:

| Key | Default | |
|---|---|---|
| `fractions` | required | the fractions, as numbers or `{ "fraction": 0.25 }`; an entry may set its own `combinations`. `plan` and `run` write each entry out in full. With `largest`: `brandsWithEndpoint`, `productsWithEndpoint` and `productFraction`, exact. With `data`: `productFractionTarget` and `memberFractionTarget`, which the run reaches or exceeds (see `endpoint-fraction.json` for what it reached) |
| `combinations` | all | the combinations every fraction runs, unless the fraction sets its own: a list of factor values. With one factor (`alg`), a value is the factor's value, such as `"derived-pattern-only"`; otherwise an object such as `{ "alg": "derived" }`, which selects every combination with those values. The script checks that `combinations/` matches `jbr-combinations.json` |
| `select` | `data` | `services.select` for every fraction |
| `kinds` | `["brands", "shops", "review_sites"]` | which of `services.brands`, `.shops` and `.review_sites` get the fraction; the others keep the base overrides' value |
| `baseOverrides` | `input/discovery-overrides.yaml` | the overrides every fraction starts from. It must set `brands.products`, `count`, `zipf` and `min_products`; its `services` section gives the values of the kinds that don't vary |
| `jbr` | `["npm", "run", "jbr", "--"]` | how jbr is run in the experiment |
| `experiment` | the config's directory | the experiment |
| `dataDigest` | | the digest the data and queries must have (from an earlier `endpoint-fraction.json`), for example to check that another machine generates the same data |

Per fraction, smallest first, `run`:

1. checks that every combination's `output/` is empty (apart from `.keep`), so a run is never mixed with another's;
2. writes `input/discovery-overrides.endpoints-<fraction>.yaml`: the base, with its `services` section replaced by the fraction's. It points `configOverrides` in every `combinations/combination_<i>/jbr-experiment.json` at that file for `jbr prepare`, then sets it back;
3. removes the previous generation (`generated/benchmark`, `logs`, `queries` and the marker), so `jbr prepare` generates from scratch and reloads the databases;
4. checks the endpoints: with `largest`, that the brands and products match the plan; with `data`, that every kind holds at least its share behind an endpoint;
5. fingerprints the data and queries (SHA-256): every publisher's graph, the placements, links and categories, every storage's documents (each storage root's `.meta` without its `void:sparqlEndpoint` line), `publishers.json` without `service`, `port` and `endpoint`, every instance's queries and reference answers, the known endpoints and `generated/queries/*.json`. The fingerprint must equal that of every complete `output-*/`;
6. checks that the endpoints are nested with every complete `output-*/`: a smaller fraction's endpoints are a subset, a larger one's a superset. It warns when a fraction has the very same endpoints as another, which is a wasted run. Complete outputs must come from the same design (`select`, `kinds` and the base's `services`);
7. runs the fraction's combinations (`jbr run`, or `jbr run -c <i>` per combination when it runs only some) and moves each one's `output/` to `output-<fraction>/combination_<i>/`, with that combination's `jbr-experiment.json` (its factor values). It adds `overrides.yaml`, `publishers.json`, `workload-summary.csv`, `fedshop-discovery.json`, `fingerprint.json`, `coverage.csv` and, last, `endpoint-fraction.json` (which lists the combinations that ran) to `output-<fraction>/`.

If a check fails, nothing is run, and a fingerprint that differs is kept in `fingerprint-mismatch-<fraction>.json`. A fraction whose `output-<fraction>/` has an `endpoint-fraction.json` is skipped, so a stopped `run` resumes where it left off; a fraction whose `combinations` change later is skipped too, so redo it with `--force`. A fraction that fails during `jbr run` leaves its output in the combinations' `output/`; move it away before running again.

`endpoint-fraction.json` is the fraction as generated. Per kind it gives the known and discoverable publishers, those with an endpoint, and the share of their products, offers or reviews behind one. For brands it also gives `poolFraction`, the same share over the products that shops and review sites deal in (`members.pool`). Over all discoverable publishers, including the reviewers, it gives `discoverableTripleFraction`. `coverage.csv` has one row per query instance: the discoverable publishers its answer needs (the workload analysis' `storages_needed`), how many of them have an endpoint, and which share of their triples.

## Changes

**2026-11-26: aligned with the full experiment of 2026-11-25 and with axis A1 of the evaluation plan.**
* Merged `master` (the full experiment): the `alg` factor, per-`alg` Dockerfiles and configs, the default-point
  `services` (`select: data`, all 1.0) and `generatorImage` `:dev`. See the full experiment's README for why. Dropped
  `derived-no-prio` and the single `Dockerfile-client`. Not taken over: `run-full.sh`, replaced by `run-vary.sh`.
* Fractions are 0, 0.25, 0.5, 0.75 and 1 (were 0 to 1 in steps of 0.2). *Why:* the plan's values. 1 is also the
  default point, but is run here as well: the generator is `:dev`, so only a run within this experiment is checked to
  have the same data as the other fractions.
* The script runs a subset of the combinations per fraction (`combinations` in `vary-endpoint-fraction.json`):
  pattern-only and the final configuration everywhere, traversal only at f = 0. *Why:* the plan runs traversal only
  at the default point and coverage 0 only, and budgets two configurations per dataset.
* 3 measured replications + 1 warm-up (was 6 + 1), and `queryInstances` `[0]` (was all). *Why:* the plan's
  replications for the axes, and the default point's queries (instance 0 of the 16 templates).
