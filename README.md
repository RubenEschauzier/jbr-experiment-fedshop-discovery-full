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

## Varying the fraction of publishers with an endpoint

`scripts/vary-endpoint-fraction.js` runs the experiment once per fraction of the discoverable publishers with a SPARQL endpoint. Every fraction needs its own generation. The data and queries stay the same, and the script checks that they do. The combinations share one generation (`commonGenerated` in `jbr-combinations.json`), so every fraction is generated once and run for every combination.

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
| `fractions` | required | the fractions, as numbers or `{ "fraction": 0.25 }`. `plan` and `run` write each entry out in full. With `largest`: `brandsWithEndpoint`, `productsWithEndpoint` and `productFraction`, exact. With `data`: `productFractionTarget` and `memberFractionTarget`, which the run reaches or exceeds (see `endpoint-fraction.json` for what it reached) |
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
7. runs `jbr run` and moves each combination's `output/` to `output-<fraction>/combination_<i>/`, with that combination's `jbr-experiment.json` (its factor values). It adds `overrides.yaml`, `publishers.json`, `workload-summary.csv`, `fedshop-discovery.json`, `fingerprint.json`, `coverage.csv` and, last, `endpoint-fraction.json` to `output-<fraction>/`.

If a check fails, nothing is run, and a fingerprint that differs is kept in `fingerprint-mismatch-<fraction>.json`. A fraction whose `output-<fraction>/` has an `endpoint-fraction.json` is skipped, so a stopped `run` resumes where it left off. A fraction that fails during `jbr run` leaves its output in the combinations' `output/`; move it away before running again.

`endpoint-fraction.json` is the fraction as generated. Per kind it gives the known and discoverable publishers, those with an endpoint, and the share of their products, offers or reviews behind one. For brands it also gives `poolFraction`, the same share over the products that shops and review sites deal in (`members.pool`). Over all discoverable publishers, including the reviewers, it gives `discoverableTripleFraction`. `coverage.csv` has one row per query instance: the discoverable publishers its answer needs (the workload analysis' `storages_needed`), how many of them have an endpoint, and which share of their triples.
