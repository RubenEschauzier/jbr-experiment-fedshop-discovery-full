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

## Configurations

The `alg` factor, in combination order:

| combination | `alg` | configuration |
|---|---|---|
| 0 | `derived` | derived full: traversal + composite sources (stars and chains of 2, star-first), whole composites |
| 1 | `derived-pattern-only` | pattern-only: traversal + every triple pattern delegated to the pod's endpoint (the baseline) |
| 2 | `derived-extended-bound` | derived full + extended blocks + bound composites: the final configuration |
| 3 | `adaptive-only` | traversal only: the same SteMs join and known federation members, no delegation (the floor) |
| 4 | `default` | traversal only with Comunica's default join, and known federation members: the reference for the SteMs join |

Every combination has its own Dockerfile, `input/dockerfiles/Dockerfile-client-<alg>`. They are the same except
that `derived-extended-bound` sets `DERIVED_EXTEND_BLOCKS=1` and `DERIVED_BOUND_COMPOSITES=1`. All use the engine
image `rubeneschauzier/comunica-query-sparql-link-traversal-solid-derived-resources:dev`.

`run-full.sh` removes every image the experiment uses (so that prepare pulls the newest `:dev` generator and engine
images and rebuilds the client images on them), generates the combinations, prepares once with `-f` (the data is
regenerated once; the combinations share it) and runs all combinations.

## Changes

**2026-11-25: aligned with the design of the instance-0 experiment of 2026-11-24/25.**
* `alg` is now `derived`, `derived-pattern-only`, `derived-extended-bound`, `adaptive-only` and `default`. Added
  `derived-extended-bound` (the final configuration). Dropped `derived-no-prio`, with its config. *Why:* the
  evaluation compares the final configuration with pattern-only, derived full is its ablation, and traversal only is
  the floor. `default` stays as the reference for the SteMs join that `adaptive-only` and the derived configurations
  use, which is new and not yet shown to perform as well as the default join.
* `services`: every discoverable publisher runs a query service (`brands`, `shops`, `review_sites` all 1.0) with
  `select: data`. It was `select: largest` with `brands: 0.25`. *Why:* this is the default point of the evaluation;
  the coverage axis lowers all three shares together from here, and `data` keeps every service of a smaller share.
* `generatorImage` is `rubeneschauzier/fedshop-discovery-generator:dev` instead of a digest. *Why:* the experiment
  follows the newest generator until the evaluation is done, and is pinned again afterwards. It only pulls an image
  that is not present, so remove the old `:dev` image before preparing (`run-full.sh` does); the image ID used is recorded in
  `generated/fedshop-discovery.json` (`generatorImageId`). The generator of 2026-11-25 puts documents in containers
  below the storage roots (at most 1,000 entries each; the taxonomy root had 18,008, 16.6 MB) and opens a fresh
  connection to the Solid server for every proxied request. Both stopped requests failing with 502 in bursts, which
  lost rows in some runs.
* `dockerfileClient` is `input/dockerfiles/Dockerfile-client-%FACTOR-alg%`, so a configuration can set engine
  switches.
