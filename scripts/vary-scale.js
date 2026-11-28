#!/usr/bin/env node
// Runs a fedshop-discovery jbr experiment once per scale of a set of generator overrides, regenerating the
// benchmark for every scale and keeping each run's output in output-<label>/.
//
// Made for axes A2 (federation size: the number of discoverable pods, every pod the same size, the known federation
// fixed; vary-n-pods.json) and A3 (pod size: the data per pod, the number of pods fixed; vary-pod-size.json) of the
// evaluation plan. A point scales every key in `scaled` by its scale s, by the key's rule:
//   scale          the base value times s
//   discoverable   (members.shops, members.review_sites) the known members stay, the others are multiplied by s;
//                  known.ratio is then set so that the generator chooses exactly as many known members as in the base
//   members        (members.pool) the base value times the growth of the shops and review sites together
// All other overrides stay as in the base. Per point the script can also change the experiment's settings (query
// timeout, Virtuoso buffers, ...) and choose which combinations run. `perPod` says what a point compares with the
// other points: `same` (A2, the default) the pods keep their size and the known members their triples; `scaled` (A3)
// every kind keeps its number of pods, and the products, offers and reviews per pod grow with the scale.
//
// Usage: npm run vary -- <plan|run|status> [config] [options]
//   (or: node scripts/vary-scale.js <plan|run|status> [config] [options])
//   plan     check every point (the brand sizes, the markets' pools, the known members, memory) and write into
//            the config what every point means
//   run      plan, then per point, smallest scale first: check, jbr prepare -f, measure, jbr run, keep the output
//            in output-<label>/, assess its health. Complete points are skipped.
//   status   the complete points: pods, data, failures and memory per combination, and whether gates pass
// Options:
//   --include <labels>   also run these optional points (comma-separated; may be repeated), e.g. --include 4
//   --force              redo points that are already complete
//   --ignore-gate        run an included optional point even if its gate fails
//   --ignore-checks      run even if the memory estimate exceeds the host's memory or the generator image changed
// The config defaults to the one vary-*.json in the current directory; the experiment is the config's directory
// unless the config names another one (`experiment`). Only Node's own modules are used.
'use strict';
const Path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

/** The default config: the one file of this form in the current directory. */
const CONFIG_PATTERN = /^vary-.+\.json$/u;
const EXPERIMENT_CONFIG = 'jbr-experiment.json';
const TEMPLATE = 'jbr-experiment.json.template';
/** What this script writes into output-<label>/ last: a directory without it is an incomplete run. */
const SUMMARY = 'point.json';
const HEALTH = 'health.json';
const PUBLISHERS = 'publishers.json';
const MARKER = 'fedshop-discovery.json';
/** Publisher kinds, and the field of publishers.json that gives a publisher's size, if any. */
const KINDS = { producer: 'products', vendor: 'offers', ratingsite: 'reviews', reviewer: undefined, taxonomy: undefined };
/** The kinds whose number a point sets directly, and the override that sets it. */
const COUNTED = { vendor: 'members.shops', ratingsite: 'members.review_sites', producer: 'brands.count' };
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
/** Virtuoso's buffers are 8 KiB pages; with its other memory, a buffer costs about 15% more. */
const BUFFER_BYTES = 8192 * 1.15;
/** Memory for the Solid server, the proxy and the host itself. */
const OTHER_BYTES = 2 * GiB;
/** An execution counts as timed out when it took at least this share of the query timeout. */
const AT_TIMEOUT = 0.98;
/** How far a kind's mean triples per pod may move from another point's before the script warns. */
const PER_POD_TOLERANCE = 0.2;
const GATE_DEFAULTS = { maxFailureShare: 0.1, maxMemoryPercent: 80 };
/** What a point compares with the other points (see the top of this file). */
const PER_POD = [ 'same', 'scaled' ];

// ----- reading and writing the overrides -----
// The script reads YAML no further than a top-level section's `key: value` lines.

/** The [start, end) lines of a top-level section, or undefined. */
function sectionLines(lines, name) {
  const start = lines.findIndex(line => new RegExp(`^${name}:`, 'u').test(line));
  if (start < 0) {
    return undefined;
  }
  let end = start + 1;
  while (end < lines.length && !/^\S/u.test(lines[end])) {
    end++;
  }
  return [ start, end ];
}

/** A top-level section's scalar values (directly below it), as strings, or undefined if there is none. */
function readSection(yaml, name) {
  const lines = yaml.split('\n');
  const range = sectionLines(lines, name);
  if (!range) {
    return undefined;
  }
  const values = {};
  for (const line of lines.slice(range[0] + 1, range[1])) {
    const match = /^ {2}(\w+):\s*([^\s#]+)/u.exec(line);
    if (match) {
      values[match[1]] = match[2];
    }
  }
  return values;
}

/** The value of `section.key`, as a string, or undefined. */
function readKey(yaml, path) {
  const [ section, key ] = splitKey(path);
  return readSection(yaml, section)?.[key];
}

/** Whether the overrides have a `section.key` line, whatever its value (also a list or a mapping). */
function hasKey(yaml, path) {
  const [ section, key ] = splitKey(path);
  const lines = yaml.split('\n');
  const range = sectionLines(lines, section);
  return Boolean(range) && lines.slice(range[0] + 1, range[1]).some(line => new RegExp(`^ {2}${key}:`, 'u').test(line));
}

/** The overrides with `section.key` set to a value, keeping the line's comment. The key must be there. */
function setKey(yaml, path, value) {
  const [ section, key ] = splitKey(path);
  const lines = yaml.split('\n');
  const range = sectionLines(lines, section);
  const pattern = new RegExp(`^( {2}${key}:\\s*)([^\\s#]+)(.*)$`, 'u');
  const index = range ? lines.findIndex((line, i) => i > range[0] && i < range[1] && pattern.test(line)) : -1;
  if (index < 0) {
    throw new Error(`The overrides do not set ${path}`);
  }
  lines[index] = lines[index].replace(pattern, `$1${value}$3`);
  return lines.join('\n');
}

function splitKey(path) {
  const parts = path.split('.');
  if (parts.length !== 2 || !parts.every(part => /^\w+$/u.test(part))) {
    throw new Error(`${path} is not a key of the form section.key`);
  }
  return parts;
}

// ----- planning -----

/**
 * Products per brand, largest first: fedshop/discovery/catalog.py brand_sizes, in the same floating-point
 * operations (the generator's Python sums floats left to right, as reduce does).
 */
function brandSizes(nProducts, count, zipf, minProducts) {
  const weights = Array.from({ length: count }, (_, k) => (k + 1) ** -zipf);
  const total = weights.reduce((sum, w) => sum + w, 0);
  const sizes = weights.map(w => Math.max(minProducts, Math.floor(nProducts * w / total)));
  sizes[0] += nProducts - sizes.reduce((sum, s) => sum + s, 0);
  if (sizes[0] < minProducts) {
    throw new Error('brands.products is too small for brands.count and brands.min_products');
  }
  return sizes;
}

/** Python's round() to an integer: halves to even. */
function pyRound(x) {
  const floor = Math.floor(x);
  if (x - floor === 0.5) {
    return floor % 2 === 0 ? floor : floor + 1;
  }
  return Math.round(x);
}

function round(x, digits = 6) {
  const factor = 10 ** digits;
  return Math.round(x * factor) / factor;
}

/** The generator's settings that a point's feasibility depends on, from overrides. */
function generatorSettings(yaml) {
  const number = (path, fallback) => {
    const value = readKey(yaml, path);
    return value === undefined ? fallback : Number(value);
  };
  return {
    shops: number('members.shops'),
    reviewSites: number('members.review_sites'),
    pool: number('members.pool'),
    products: number('brands.products'),
    count: number('brands.count'),
    zipf: number('brands.zipf'),
    minProducts: number('brands.min_products'),
    markets: Math.max(1, number('markets.count', 1)),
    globalBrands: number('markets.global_brands', 0),
    globalShare: number('markets.global_share', 0),
    knownRatio: number('known.ratio', 0.5),
  };
}

/**
 * What the generator would reject, or what changes the design, for one point's overrides: as in
 * catalog.brand_sizes, markets.Markets (every market's pool from its own brands) and publishing.choose_known.
 * Returns { problems, warnings, brandSizes, known }.
 */
function feasibility(s) {
  const problems = [];
  const warnings = [];
  for (const [ key, value ] of Object.entries(s)) {
    if (!Number.isFinite(value)) {
      problems.push(`${key} is not set`);
    }
  }
  if (problems.length > 0) {
    return { problems, warnings };
  }
  let sizes;
  try {
    sizes = brandSizes(s.products, s.count, s.zipf, s.minProducts);
  } catch (error) {
    problems.push(error.message);
    return { problems, warnings };
  }
  if (s.products < s.pool) {
    problems.push(`brands.products (${s.products}) is below members.pool (${s.pool})`);
  }
  if (s.markets > 1) {
    const size = Math.floor(s.pool / s.markets);
    const nGlobal = s.globalBrands;
    const nShared = nGlobal > 0 ? pyRound(s.globalShare * size) : 0;
    const global = sizes.slice(0, nGlobal).reduce((sum, n) => sum + n, 0);
    if (global < nShared) {
      problems.push(`the global brands have ${global} products, not the ${nShared} each market shares`);
    }
    for (let m = 0; m < s.markets; m++) {
      const local = sizes.reduce((sum, n, b) => sum + (b >= nGlobal && (b - nGlobal) % s.markets === m ? n : 0), 0);
      if (local < size - nShared) {
        problems.push(`market ${m} has ${local} products of its own brands, not the ${size - nShared} its pool needs`);
      }
    }
  }
  const known = {};
  for (const [ kind, n ] of [ [ 'shops', s.shops ], [ 'review_sites', s.reviewSites ] ]) {
    if (s.markets > 1 && n < s.markets) {
      problems.push(`${n} ${kind} leave markets without a member (markets.count is ${s.markets})`);
    }
    known[kind] = knownMembers(n, s.markets, s.knownRatio);
  }
  return { problems, warnings, brandSizes: sizes, known };
}

/**
 * The known members of one kind, as publishing.choose_known chooses them: per market (member i is in market
 * i mod count), round(ratio * members), at least one per market with markets.
 */
function knownMembers(n, markets, ratio) {
  const perMarket = [];
  for (let m = 0; m < markets; m++) {
    const group = Math.floor(n / markets) + (m < n % markets ? 1 : 0);
    perMarket.push(group > 0 ? Math.max(markets > 1 ? 1 : 0, pyRound(ratio * group)) : 0);
  }
  const known = perMarket.reduce((sum, k) => sum + k, 0);
  return { members: n, known, discoverable: n - known, perMarket };
}

/** The template's value at a dotted path (such as hookSparqlEndpoint.queryTimeout), or undefined. */
function getPath(object, path) {
  return path.split('.').reduce((value, key) => value?.[key], object);
}

function setPath(object, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const parent = keys.reduce((value, key) => value?.[key], object);
  if (!parent || typeof parent !== 'object' || !(last in parent)) {
    throw new Error(`${path} is not a setting of ${EXPERIMENT_CONFIG}`);
  }
  parent[last] = value;
}

/** The settings a point runs with: the template's, with the point's over them. */
function effectiveSettings(template, settings) {
  const keys = [
    'queryTimeoutFallback', 'virtuosoBuffersMain', 'virtuosoBuffersKnown', 'readinessTimeout',
    'queryRunnerReplication', 'queryRunnerWarmupRounds', 'queryInstances',
    'hookSparqlEndpoint.queryTimeout', 'hookSparqlEndpoint.maxMemory',
  ];
  const effective = Object.fromEntries(keys.map(key => [ key, getPath(template, key) ]));
  return { ...effective, ...settings };
}

/** Peak memory the point needs on the host: Virtuoso's buffers, the engine's heap and the rest. */
function memoryEstimate(effective) {
  return (effective.virtuosoBuffersMain + effective.virtuosoBuffersKnown) * BUFFER_BYTES +
    effective['hookSparqlEndpoint.maxMemory'] * MiB + OTHER_BYTES;
}

/** The kind a `discoverable` key counts. */
const MEMBER_KEYS = { 'members.shops': 'shops', 'members.review_sites': 'review_sites' };
const RULES = [ 'scale', 'discoverable', 'members' ];

/**
 * One point's overrides: every scaled key by its rule (see the top of this file), and, when members scale as
 * discoverable, known.ratio such that the generator keeps the known members of config.known.
 */
function scaleOverrides(config, base, scale) {
  const b = generatorSettings(base);
  let yaml = base;
  const overrides = {};
  const inexact = [];
  const set = (key, exact) => {
    overrides[key] = Math.round(exact);
    if (Math.abs(exact - overrides[key]) > 1e-9) {
      inexact.push(`${key} ${round(exact)} rounded to ${overrides[key]}`);
    }
    yaml = setKey(yaml, key, overrides[key]);
  };
  const rules = Object.entries(config.scaled);
  for (const [ key, rule ] of rules.filter(([ , r ]) => r === 'scale')) {
    set(key, Number(readKey(base, key)) * scale);
  }
  for (const [ key, rule ] of rules.filter(([ , r ]) => r === 'discoverable')) {
    const known = config.known[MEMBER_KEYS[key]];
    set(key, known + (Number(readKey(base, key)) - known) * scale);
  }
  const shops = overrides['members.shops'] ?? b.shops;
  const reviewSites = overrides['members.review_sites'] ?? b.reviewSites;
  for (const [ key, rule ] of rules.filter(([ , r ]) => r === 'members')) {
    set(key, Number(readKey(base, key)) * (shops + reviewSites) / (b.shops + b.reviewSites));
  }
  if (rules.some(([ , r ]) => r === 'discoverable')) {
    // One ratio for both kinds: exact when they have as many members, which the known check below confirms
    overrides['known.ratio'] = (config.known.shops + config.known.review_sites) / (shops + reviewSites);
    yaml = setKey(yaml, 'known.ratio', overrides['known.ratio']);
  }
  return { yaml, overrides, inexact };
}

function planPoint(config, point) {
  const base = fs.readFileSync(config.baseOverridesPath, 'utf8');
  const { yaml, overrides, inexact } = scaleOverrides(config, base, point.scale);
  const check = feasibility(generatorSettings(yaml));
  for (const [ kind, target ] of Object.entries(config.known)) {
    const got = check.known?.[kind];
    if (got && got.known !== target) {
      check.problems.push(`the generator would choose ${got.known} known ${kind} (${got.perMarket.join(' + ')} per market), ` +
        `not ${target}`);
    }
  }
  const effective = effectiveSettings(config.template, point.settings);
  const entry = { label: point.label, scale: point.scale };
  if (point.optional) {
    entry.optional = true;
  }
  if (point.gate) {
    entry.gate = point.gate;
  }
  if (point.combinations) {
    entry.combinations = point.combinations;
  }
  if (Object.keys(point.settings).length > 0) {
    entry.settings = point.settings;
  }
  Object.assign(entry, {
    overrides,
    known: check.known && Object.fromEntries(Object.entries(check.known).map(([ kind, k ]) =>
      [ kind, { members: k.members, known: k.known, discoverable: k.discoverable } ])),
    memoryEstimateGiB: round(memoryEstimate(effective) / GiB, 1),
  });
  return {
    entry,
    yaml,
    effective,
    problems: check.problems,
    warnings: [ ...check.warnings, ...inexact.map(text => `inexact: ${text}`) ],
  };
}

function plan(config) {
  return config.points.map(point => planPoint(config, point));
}

/** Write the plan into the config, so the config shows what every point means. */
function writePlan(config, planned) {
  const raw = { ...config.raw, points: planned.map(p => p.entry) };
  fs.writeFileSync(config.path, `${JSON.stringify(raw, null, 2)}\n`);
}

function printPlan(config, planned) {
  console.log(`scaling ${Object.entries(config.scaled).map(([ key, rule ]) => `${key} (${rule})`).join(', ')}; ` +
    `known: ${Object.entries(config.known).map(([ kind, n ]) => `${n} ${kind}`).join(', ')}; per pod: ${config.perPod}`);
  for (const p of planned) {
    const e = p.entry;
    const flags = [ e.optional ? 'optional' : '', e.gate ? `gate: point ${e.gate.point}` : '' ].filter(Boolean);
    console.log(`  ${`x${e.label}`.padEnd(6)} ${Object.entries(e.overrides).map(([ k, v ]) => `${k} ${round(v, 4)}`).join(', ')}` +
      (flags.length > 0 ? ` (${flags.join(', ')})` : ''));
    const settings = Object.entries(e.settings ?? {}).map(([ k, v ]) => `${k} ${JSON.stringify(v)}`);
    console.log(`  ${''.padEnd(6)} memory about ${e.memoryEstimateGiB} GiB of ${round(os.totalmem() / GiB, 1)} GiB here` +
      (settings.length > 0 ? `; ${settings.join(', ')}` : ''));
    const selected = config.selection[e.label];
    if (selected) {
      console.log(`  ${''.padEnd(6)} runs ${selected.length}/${config.combinations.length} combinations: ` +
        selected.map(c => Object.values(c.factors).join('/')).join(', '));
    }
    for (const warning of p.warnings) {
      console.log(`  ${''.padEnd(6)} warning: ${warning}`);
    }
    for (const problem of p.problems) {
      console.log(`  ${''.padEnd(6)} PROBLEM: ${problem}`);
    }
  }
}

// ----- config -----

function loadConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`No config at ${configPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const dir = Path.dirname(configPath);
  const experiment = Path.resolve(dir, raw.experiment ?? '.');
  const combinations = readCombinations(experiment);
  if (!combinations && !fs.existsSync(Path.join(experiment, EXPERIMENT_CONFIG))) {
    throw new Error(`${experiment} is not a jbr experiment (no ${EXPERIMENT_CONFIG} or jbr-combinations.json)`);
  }
  const templatePath = Path.join(experiment, combinations ? TEMPLATE : EXPERIMENT_CONFIG);
  const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
  const baseOverrides = raw.baseOverrides ?? 'input/discovery-overrides.yaml';
  const baseOverridesPath = Path.resolve(experiment, baseOverrides);
  const base = fs.readFileSync(baseOverridesPath, 'utf8');

  // scaled: { "section.key": rule }, or a list of keys that all scale
  const scaled = Array.isArray(raw.scaled) ? Object.fromEntries(raw.scaled.map(key => [ key, 'scale' ])) : raw.scaled;
  if (!scaled || typeof scaled !== 'object' || Object.keys(scaled).length === 0) {
    throw new Error('scaled must give the overrides to scale, as { "section.key": rule }');
  }
  for (const [ key, rule ] of Object.entries(scaled)) {
    if (!RULES.includes(rule)) {
      throw new Error(`scaled.${key}: the rule must be one of ${RULES.join(', ')}, not ${JSON.stringify(rule)}`);
    }
    if (rule === 'discoverable' && !(key in MEMBER_KEYS)) {
      throw new Error(`scaled.${key}: only ${Object.keys(MEMBER_KEYS).join(' and ')} scale as discoverable`);
    }
    const value = readKey(base, key);
    if (value === undefined || !Number.isFinite(Number(value))) {
      throw new Error(`${baseOverrides} must set ${key} to a number (the script scales the base, not the image's defaults)`);
    }
  }
  const perPod = raw.perPod ?? 'same';
  if (!PER_POD.includes(perPod)) {
    throw new Error(`perPod must be one of ${PER_POD.join(', ')}, not ${JSON.stringify(perPod)}`);
  }
  const discoverable = Object.values(scaled).includes('discoverable');
  if (discoverable && (!hasKey(base, 'known.ratio') || hasKey(base, 'known.members'))) {
    throw new Error(`${baseOverrides} must set known.ratio (and not known.members): the script sets the ratio per point`);
  }
  // The known members every point keeps: as configured, or as the base chooses them
  const b = generatorSettings(base);
  const baseKnown = {
    shops: knownMembers(b.shops, b.markets, b.knownRatio).known,
    review_sites: knownMembers(b.reviewSites, b.markets, b.knownRatio).known,
  };
  const known = { ...baseKnown, ...raw.known };
  for (const [ kind, n ] of Object.entries(known)) {
    if (!(kind in baseKnown) || !Number.isInteger(n) || n < 0) {
      throw new Error(`known.${kind} must be a number of known shops or review_sites`);
    }
  }

  const points = (raw.points ?? []).map(p => typeof p === 'number' ? { scale: p } : p).map(p => ({
    label: String(p.label ?? p.scale),
    scale: p.scale,
    optional: p.optional === true,
    gate: p.gate,
    settings: p.settings ?? {},
    combinations: p.combinations,
  }));
  if (points.length === 0 || points.some(p => typeof p.scale !== 'number' || !(p.scale > 0))) {
    throw new Error('points must list scales above 0');
  }
  const labels = points.map(p => p.label);
  if (new Set(labels).size !== labels.length || labels.some(l => !/^[\w.-]+$/u.test(l))) {
    throw new Error(`point labels must be distinct and usable in a file name: ${labels.join(', ')}`);
  }
  const selection = {};
  for (const point of points) {
    for (const path of Object.keys(point.settings)) {
      setPath(structuredClone(template), path, point.settings[path]);
    }
    if (point.gate) {
      if (!labels.includes(String(point.gate.point)) || String(point.gate.point) === point.label) {
        throw new Error(`point ${point.label}: gate.point must be another point's label`);
      }
      point.gate = { ...GATE_DEFAULTS, ...point.gate, point: String(point.gate.point) };
    }
    selection[point.label] = selectCombinations(point.combinations ?? raw.combinations, combinations, `point ${point.label}`);
  }
  return {
    path: configPath,
    raw,
    experiment,
    combinations,
    selection,
    template,
    scaled,
    perPod,
    known,
    baseOverrides,
    baseOverridesPath,
    jbr: raw.jbr ?? [ 'npm', 'run', 'jbr', '--' ],
    points,
  };
}

/** The factor values of every combination, in jbr's order (as jbr's FullFactorialCombinationProvider). */
function factorCombinations(factors) {
  let combinations = [ {} ];
  for (const [ factor, values ] of Object.entries(factors)) {
    combinations = values.flatMap(value => combinations.map(combination => ({ ...combination, [factor]: value })));
  }
  return combinations;
}

/**
 * The combinations of a combination-based experiment (combinations/combination_<i>, in jbr's order, each with
 * its id and factor values), or undefined for an experiment with one jbr-experiment.json. Its combinations must
 * share generated/ (commonGenerated): a point is one generation, which every combination runs against.
 */
function readCombinations(experiment) {
  const file = Path.join(experiment, 'jbr-combinations.json');
  if (!fs.existsSync(file)) {
    return undefined;
  }
  const provider = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (provider.commonGenerated !== true) {
    throw new Error(`${file} must set "commonGenerated": true, so that every combination runs against the same generation`);
  }
  const dir = Path.join(experiment, 'combinations');
  const names = (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
    .filter(name => /^combination_\d+$/u.test(name) && fs.existsSync(Path.join(dir, name, EXPERIMENT_CONFIG)))
    .sort((a, b) => Number(a.split('_')[1]) - Number(b.split('_')[1]));
  if (names.length === 0) {
    throw new Error(`No combinations/combination_*/${EXPERIMENT_CONFIG}: run npm run jbr -- generate-combinations first`);
  }
  const factors = factorCombinations(provider.factors ?? {});
  if (names.length !== factors.length || names.some((name, i) => name !== `combination_${i}`)) {
    throw new Error(`combinations/ holds ${names.join(', ')}, but jbr-combinations.json gives ${factors.length} ` +
      'combinations: run npm run jbr -- generate-combinations again');
  }
  return names.map((name, id) => ({ name, id, factors: factors[id] }));
}

/**
 * The combinations a list of factor values selects, in jbr's order; all of them if there is no list. An entry is
 * an object of factor values (it selects every combination with those values), or, if there is only one factor,
 * that factor's value.
 */
function selectCombinations(spec, combinations, where) {
  if (spec === undefined) {
    return combinations;
  }
  if (!combinations) {
    throw new Error(`${where}: combinations can only be chosen in an experiment with jbr-combinations.json`);
  }
  if (!Array.isArray(spec) || spec.length === 0) {
    throw new Error(`${where}: combinations must be a non-empty list of factor values`);
  }
  const factorNames = Object.keys(combinations[0].factors);
  const ids = new Set();
  for (const entry of spec) {
    if (typeof entry === 'string' && factorNames.length !== 1) {
      throw new Error(`${where}: with factors ${factorNames.join(', ')}, a combination is an object of factor values, not ${JSON.stringify(entry)}`);
    }
    const wanted = typeof entry === 'string' ? { [factorNames[0]]: entry } : entry;
    const matches = combinations.filter(c => Object.entries(wanted).every(([ key, value ]) => c.factors[key] === value));
    if (matches.length === 0) {
      throw new Error(`${where}: no combination has ${JSON.stringify(wanted)}`);
    }
    for (const match of matches) {
      ids.add(match.id);
    }
  }
  return combinations.filter(c => ids.has(c.id));
}

/** The jbr-experiment.json files of the experiment: one, or one per combination. */
function experimentConfigs(config) {
  return config.combinations ?
    config.combinations.map(({ name }) => Path.join(config.experiment, 'combinations', name, EXPERIMENT_CONFIG)) :
    [ Path.join(config.experiment, EXPERIMENT_CONFIG) ];
}

/** Where jbr run writes: output/, or each given combination's output/, with the name it gets in output-<label>/. */
function outputDirs(config, combinations = config.combinations) {
  return combinations ?
    combinations.map(({ name }) => ({ name, dir: Path.join(config.experiment, 'combinations', name, 'output') })) :
    [ { name: undefined, dir: Path.join(config.experiment, 'output') } ];
}

// ----- measuring what was generated -----

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** Files under a directory, relative to it, sorted, with their sizes. */
function walk(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(Path.join(dir, prefix), { withFileTypes: true })
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...walk(dir, rel));
    } else if (entry.isFile()) {
      out.push({ rel, size: fs.statSync(Path.join(dir, rel)).size });
    }
  }
  return out;
}

function stats(values) {
  if (values.length === 0) {
    return { mean: 0, median: 0, min: 0, max: 0 };
  }
  const sorted = [ ...values ].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    mean: round(sorted.reduce((sum, v) => sum + v, 0) / sorted.length, 2),
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    min: sorted[0],
    max: sorted.at(-1),
  };
}

/**
 * The federation as generated: per kind of publisher the pods (known, discoverable, with an endpoint), their
 * triples and, where publishers.json gives it, their size (products, offers or reviews); the documents and
 * storages served; and the bytes generated.
 */
function measure(generated) {
  const benchmark = Path.join(generated, 'benchmark');
  const publishers = JSON.parse(fs.readFileSync(Path.join(benchmark, PUBLISHERS), 'utf8'));
  const web = Path.join(benchmark, 'web');
  const files = fs.existsSync(web) ? walk(web) : [];
  // Documents per storage (web/<publisher>/, without its .meta)
  const documents = {};
  for (const { rel } of files) {
    const slash = rel.indexOf('/');
    if (slash > 0 && Path.basename(rel) !== '.meta') {
      documents[rel.slice(0, slash)] = (documents[rel.slice(0, slash)] ?? 0) + 1;
    }
  }
  const kinds = {};
  for (const kind of new Set([ ...Object.keys(KINDS), ...Object.values(publishers).map(p => p.kind) ])) {
    const all = Object.values(publishers).filter(p => p.kind === kind);
    if (all.length === 0) {
      continue;
    }
    const size = KINDS[kind];
    kinds[kind] = {
      pods: all.length,
      known: all.filter(p => p.known).length,
      knownTriples: all.filter(p => p.known).reduce((sum, p) => sum + p.triples, 0),
      withEndpoint: all.filter(p => p.service).length,
      triples: all.reduce((sum, p) => sum + p.triples, 0),
      triplesPerPod: stats(all.map(p => p.triples)),
      documentsPerPod: stats(Object.entries(publishers).filter(([ , p ]) => p.kind === kind).map(([ name ]) => documents[name] ?? 0)),
      ...size && all.every(p => typeof p[size] === 'number') ? { [`${size}PerPod`]: stats(all.map(p => p[size])) } : {},
    };
  }
  const generatedFiles = walk(benchmark);
  return {
    pods: Object.values(kinds).reduce((sum, k) => sum + k.pods, 0),
    triples: Object.values(kinds).reduce((sum, k) => sum + k.triples, 0),
    storages: new Set(files.map(f => f.rel.split('/')[0]).filter(name => files.some(f => f.rel.startsWith(`${name}/`)))).size,
    documents: files.filter(f => Path.basename(f.rel) !== '.meta').length,
    generatedBytes: generatedFiles.reduce((sum, f) => sum + f.size, 0),
    kinds,
  };
}

/** One line of Python's or the runner's CSV (quoted fields with doubled quotes). */
function parseCsvLine(line, separator = ',') {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === separator) {
      out.push(field);
      field = '';
    } else {
      field += c.replace('\r', '');
    }
  }
  out.push(field);
  return out;
}

function readCsv(file, separator = ',') {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const header = parseCsvLine(lines[0], separator);
  return lines.slice(1).map(line => Object.fromEntries(parseCsvLine(line, separator).map((value, i) => [ header[i], value ])));
}

/**
 * The query instances the experiment runs (queryInstances; all if empty), from the workload analysis: per
 * template its kind, category, reference rows, the publishers its answer needs and a hash of its query. Also the
 * templates without such an instance, which this point cannot compare.
 */
function instances(generated, queryInstances) {
  const benchmark = Path.join(generated, 'benchmark');
  const rows = readCsv(Path.join(benchmark, 'workload-summary.csv'));
  const wanted = row => row.selected === 'True' && (queryInstances.length === 0 || queryInstances.includes(Number(row.instance)));
  const templates = [ ...new Set(rows.map(row => row.query)) ].sort();
  const lines = [ 'query,instance,kind,category,reference_rows,storages_needed,plain_sha256' ];
  for (const row of rows.filter(wanted)) {
    const plain = Path.join(benchmark, 'workload', row.query, `instance_${row.instance}`, 'plain.sparql');
    lines.push([
      row.query, row.instance, row.kind, row.category, row.reference_rows,
      (row.storages_needed ?? '').split(' ').filter(Boolean).length,
      fs.existsSync(plain) ? sha256(fs.readFileSync(plain)).slice(0, 16) : '',
    ].join(','));
  }
  const present = new Set(rows.filter(wanted).map(row => row.query));
  return { csv: `${lines.join('\n')}\n`, count: lines.length - 1, missing: templates.filter(t => !present.has(t)) };
}

/**
 * Problems when the generated federation is not the planned one: per counted kind, as many pods as the overrides
 * give, and exactly the configured known shops and review sites.
 */
function checkGenerated(config, yaml, measured) {
  const problems = [];
  const s = generatorSettings(yaml);
  const pods = { vendor: s.shops, ratingsite: s.reviewSites, producer: s.count };
  for (const [ kind, expected ] of Object.entries(pods)) {
    const got = measured.kinds[kind]?.pods ?? 0;
    if (got !== expected) {
      problems.push(`${got} ${kind} pods, the overrides give ${expected} (${COUNTED[kind]})`);
    }
  }
  for (const [ kind, key ] of [ [ 'vendor', 'shops' ], [ 'ratingsite', 'review_sites' ] ]) {
    const got = measured.kinds[kind]?.known ?? 0;
    if (got !== config.known[key]) {
      problems.push(`${got} known ${key}, not ${config.known[key]}`);
    }
  }
  return problems;
}

/**
 * Warnings when the federation does not relate to the other points' as the axis says (perPod):
 * - same (A2): per counted kind, the mean triples per pod, and the known shops' and review sites' triples together
 *   (they are the same members at every point), stay within the tolerance;
 * - scaled (A3): every kind has as many pods as at the other points (also the reviewers, whose number
 *   members.reviews_per_reviewer keeps), and per counted kind the mean products, offers or reviews per pod grow with
 *   the scale, within the tolerance. Triples and documents per pod are only measured: they grow by less, as a pod's
 *   own description and, once every product of the pool is listed, the listings and product pages do not grow.
 */
function compareWithPoints(measured, runs, perPod = 'same', scale = 1) {
  const warnings = [];
  const off = (a, b) => Math.abs(a / b - 1) > PER_POD_TOLERANCE;
  for (const run of runs) {
    if (perPod === 'scaled') {
      const expected = scale / run.summary.scale;
      for (const kind of new Set([ ...Object.keys(measured.kinds), ...Object.keys(run.summary.measured.kinds) ])) {
        const here = measured.kinds[kind]?.pods ?? 0;
        const there = run.summary.measured.kinds[kind]?.pods ?? 0;
        if (here !== there) {
          warnings.push(`${kind}: ${here} pods, ${there} in ${run.name}: the number of pods changed`);
        }
      }
      for (const kind of Object.keys(COUNTED)) {
        const field = `${KINDS[kind]}PerPod`;
        const here = measured.kinds[kind]?.[field];
        const there = run.summary.measured.kinds[kind]?.[field];
        if (here && there && off(here.mean / there.mean, expected)) {
          warnings.push(`${kind}: ${here.mean} ${KINDS[kind]} per pod, ${there.mean} in ${run.name} ` +
            `(x${round(here.mean / there.mean, 2)}, the scales give x${round(expected, 2)}): the pods did not grow with the scale`);
        }
      }
      continue;
    }
    for (const kind of Object.keys(COUNTED)) {
      const here = measured.kinds[kind];
      const there = run.summary.measured.kinds[kind];
      if (!here || !there) {
        continue;
      }
      if (off(here.triplesPerPod.mean, there.triplesPerPod.mean)) {
        warnings.push(`${kind}: ${here.triplesPerPod.mean} triples per pod, ${there.triplesPerPod.mean} in ${run.name} ` +
          `(x${round(here.triplesPerPod.mean / there.triplesPerPod.mean, 2)}): the pods are not the same size`);
      }
      if (here.knownTriples > 0 && there.knownTriples > 0 && off(here.knownTriples, there.knownTriples)) {
        warnings.push(`${kind}: the known members have ${here.knownTriples} triples, ${there.knownTriples} in ${run.name} ` +
          `(x${round(here.knownTriples / there.knownTriples, 2)}): the known federation changed size`);
      }
    }
  }
  return warnings;
}

// ----- health of a run -----

/** Peak memory per stats-<component>.csv of a combination's output. */
function memoryPeaks(output) {
  const peaks = {};
  for (const file of fs.existsSync(output) ? fs.readdirSync(output) : []) {
    const match = /^stats-(.+)\.csv$/u.exec(file);
    if (!match) {
      continue;
    }
    let bytes = 0;
    let percent = 0;
    for (const row of readCsv(Path.join(output, file))) {
      bytes = Math.max(bytes, Number(row.memory) || 0);
      percent = Math.max(percent, Number(row.memory_percentage) || 0);
    }
    peaks[match[1]] = { bytes, percent: round(percent, 2) };
  }
  return peaks;
}

/**
 * Per combination: its executions (not the warm-up), those with an error, those incomplete against the reference,
 * those that ran into the query timeout, and the share that failed in any of these ways; and its components' peak
 * memory. Over all: the largest failure share, and the sum of the components' peak memory as a share of the
 * host's (an upper bound of what was in use at once).
 */
function health(target, combinations, effective) {
  const timeoutMs = effective['hookSparqlEndpoint.queryTimeout'] * 1000;
  const heapBytes = effective['hookSparqlEndpoint.maxMemory'] * MiB;
  const result = { combinations: {} };
  for (const { name, factors } of combinations ?? [ { name: undefined, factors: {} } ]) {
    const output = name ? Path.join(target, name) : target;
    const file = Path.join(output, 'query-executions.csv');
    const rows = fs.existsSync(file) ? readCsv(file, ';') : [];
    const errors = rows.filter(r => r.error === 'true');
    const incomplete = rows.filter(r => r.complete === 'false');
    const atTimeout = rows.filter(r => Number(r.time) >= AT_TIMEOUT * timeoutMs);
    const failed = rows.filter(r => r.error === 'true' || r.complete === 'false' || Number(r.time) >= AT_TIMEOUT * timeoutMs);
    const memory = memoryPeaks(output);
    const engine = memory['sparql-endpoint-comunica'];
    result.combinations[name ?? 'output'] = {
      ...factors,
      executions: rows.length,
      errors: errors.length,
      incomplete: incomplete.length,
      atTimeout: atTimeout.length,
      failed: failed.length,
      failureShare: rows.length > 0 ? round(failed.length / rows.length, 4) : 1,
      failedQueries: [ ...new Set(failed.map(r => `${r.name}#${r.id}`)) ].sort(),
      memory,
      memoryPercentSum: round(Object.values(memory).reduce((sum, m) => sum + m.percent, 0), 2),
      ...engine ? { enginePeakOfHeap: round(engine.bytes / heapBytes, 3) } : {},
    };
  }
  const all = Object.values(result.combinations);
  result.maxFailureShare = Math.max(...all.map(c => c.failureShare));
  result.maxMemoryPercent = Math.max(...all.map(c => c.memoryPercentSum));
  return result;
}

/** Why a gate does not pass, from its point's health; empty if it passes. */
function gateProblems(gate, gateHealth) {
  const problems = [];
  for (const [ name, c ] of Object.entries(gateHealth.combinations)) {
    if (c.failureShare > gate.maxFailureShare) {
      problems.push(`${name} (${Object.values(c).filter(v => typeof v === 'string').join('/')}) failed ` +
        `${c.failed}/${c.executions} executions (${c.errors} errors, ${c.incomplete} incomplete, ${c.atTimeout} at the ` +
        `timeout), more than ${gate.maxFailureShare * 100}%`);
    }
    if (c.memoryPercentSum > gate.maxMemoryPercent) {
      problems.push(`${name}: its components peaked at ${c.memoryPercentSum}% of the host's memory together, ` +
        `more than ${gate.maxMemoryPercent}%`);
    }
  }
  return problems;
}

// ----- images -----

/**
 * The engine images the selected combinations build on (the FROM of their Dockerfiles), with their local IDs:
 * every point must run on the same engine, as on the same generator. An ID is undefined if Docker cannot say.
 */
function engineImages(config, combinations) {
  const images = {};
  for (const file of experimentConfigs(config).filter((_, i) => !combinations || combinations.some(c => c.id === i))) {
    const dockerfile = getPath(JSON.parse(fs.readFileSync(file, 'utf8')), 'hookSparqlEndpoint.dockerfileClient');
    const path = dockerfile && Path.resolve(Path.dirname(file), dockerfile);
    const from = path && fs.existsSync(path) ? /^FROM\s+(\S+)/mu.exec(fs.readFileSync(path, 'utf8'))?.[1] : undefined;
    if (from && !(from in images)) {
      try {
        images[from] = execFileSync('docker', [ 'image', 'inspect', '--format', '{{.Id}}', from ], { encoding: 'utf8' }).trim();
      } catch {
        images[from] = undefined;
      }
    }
  }
  return images;
}

/** Problems when an image's ID differs from that of a complete point. */
function imageChanges(images, runs) {
  const problems = [];
  for (const run of runs) {
    for (const [ image, id ] of Object.entries(run.summary.engineImages ?? {})) {
      if (id && images[image] && images[image] !== id) {
        problems.push(`${image} is ${images[image]}, ${run.name} ran on ${id}`);
      }
    }
  }
  return problems;
}

// ----- running -----

function jbr(config, args) {
  const [ command, ...base ] = config.jbr;
  console.log(`\n$ ${[ command, ...base, ...args ].join(' ')}`);
  return new Promise((resolve, reject) => {
    // jbr gets Ctrl+C too (same process group) and cleans up its containers itself
    const child = spawn(command, [ ...base, ...args ], { cwd: config.experiment, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${[ command, ...base, ...args ].join(' ')} failed (${signal ?? `exit code ${code}`})`));
      }
    });
  });
}

/** Whether output/ holds nothing but jbr's .keep. */
function outputEmpty(output) {
  return !fs.existsSync(output) || fs.readdirSync(output).every(name => name === '.keep');
}

/** The complete points: output-<label>/ with its summary and health. */
function completedRuns(experiment) {
  return fs.readdirSync(experiment)
    .filter(name => /^output-.+/u.test(name) && !name.includes('.replaced-') && fs.existsSync(Path.join(experiment, name, SUMMARY)))
    .map(name => {
      const read = file => JSON.parse(fs.readFileSync(Path.join(experiment, name, file), 'utf8'));
      return { name, label: name.slice('output-'.length), summary: read(SUMMARY), health: read(HEALTH) };
    });
}

/** Free bytes on the file system of a path, or undefined if it cannot be read. */
function freeBytes(path) {
  try {
    const s = fs.statfsSync(path);
    return s.bavail * s.bsize;
  } catch {
    return undefined;
  }
}

/**
 * Problems that stop a point before it generates: the memory it needs, and the generator image of the complete
 * points. Warns when the disk may be too small, estimated from the nearest complete point's generated bytes.
 */
function preflight(config, planned, runs) {
  const problems = [];
  const estimate = memoryEstimate(planned.effective);
  if (estimate > os.totalmem()) {
    problems.push(`point ${planned.entry.label} needs about ${round(estimate / GiB, 1)} GiB (Virtuoso's buffers, the engine's heap ` +
      `and ${OTHER_BYTES / GiB} GiB for the rest), more than the host's ${round(os.totalmem() / GiB, 1)} GiB: lower its ` +
      'virtuosoBuffersMain and virtuosoBuffersKnown');
  }
  const images = new Set(runs.map(run => run.summary.generatorImageId).filter(Boolean));
  if (images.size > 1) {
    problems.push(`the complete points come from different generator images: ${[ ...images ].join(', ')}`);
  }
  const nearest = [ ...runs ].sort((a, b) =>
    Math.abs(a.summary.scale - planned.entry.scale) - Math.abs(b.summary.scale - planned.entry.scale))[0];
  if (nearest) {
    // The generated files, Virtuoso's databases (about as large) and the output
    const needed = nearest.summary.measured.generatedBytes * planned.entry.scale / nearest.summary.scale * 2.5;
    for (const path of [ config.experiment, '/var/lib/docker' ]) {
      const free = freeBytes(path);
      if (free !== undefined && free < needed) {
        console.warn(`Warning: ${path} has ${round(free / GiB, 1)} GiB free; point ${planned.entry.label} may need about ` +
          `${round(needed / GiB, 1)} GiB (from ${nearest.name})`);
      }
    }
  }
  return problems;
}

/** The point's experiment configs: configOverrides at its overrides and its settings. Returns how to undo it. */
function applyPoint(config, overrides, settings) {
  const originals = [];
  try {
    for (const file of experimentConfigs(config)) {
      const text = fs.readFileSync(file, 'utf8');
      originals.push([ file, text ]);
      const json = JSON.parse(text);
      setPath(json, 'configOverrides', overrides);
      for (const [ path, value ] of Object.entries(settings)) {
        setPath(json, path, value);
      }
      fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
    }
  } catch (error) {
    restore(originals);
    throw error;
  }
  return () => restore(originals);
}

function restore(originals) {
  for (const [ file, text ] of originals) {
    fs.writeFileSync(file, text);
  }
}

async function runPoint(config, planned, options, interrupted) {
  const { entry } = planned;
  const label = entry.label;
  const experiment = config.experiment;
  const generated = Path.join(experiment, 'generated');
  const selected = config.selection[label];
  const target = Path.join(experiment, `output-${label}`);

  if (fs.existsSync(Path.join(target, SUMMARY)) && !options.force) {
    console.log(`\n=== x${label}: already done in ${Path.basename(target)}, skipped (--force redoes it)`);
    return;
  }
  if (entry.optional && !options.include.has(label)) {
    console.log(`\n=== x${label}: optional, skipped (--include ${label} runs it)`);
    return;
  }
  if (planned.problems.length > 0) {
    throw new Error(`x${label} cannot be generated:\n  ${planned.problems.join('\n  ')}`);
  }
  if (fs.existsSync(target)) {
    if (!options.force) {
      throw new Error(`${target} exists but is incomplete (no ${SUMMARY}); remove it or pass --force`);
    }
    // Kept, not removed: a redo that fails must not lose the earlier results
    const kept = `${target}.replaced-${new Date().toISOString().replace(/[:.]/gu, '-')}`;
    fs.renameSync(target, kept);
    console.log(`Moved the earlier ${Path.basename(target)} to ${Path.basename(kept)}`);
  }
  const runs = completedRuns(experiment).filter(run => run.label !== label);
  if (entry.gate) {
    const gateRun = runs.find(run => run.label === entry.gate.point);
    const problems = gateRun ?
      gateProblems(entry.gate, gateRun.health) :
      [ `x${entry.gate.point} has not run yet` ];
    if (problems.length > 0) {
      const text = `the gate of x${label} (x${entry.gate.point}) does not pass:\n  ${problems.join('\n  ')}`;
      if (!options.ignoreGate) {
        throw new Error(`${text}\n--ignore-gate runs it anyway`);
      }
      console.warn(`Warning: ${text}\nRunning anyway (--ignore-gate)`);
    }
  }
  const problems = preflight(config, planned, runs);
  if (problems.length > 0) {
    if (!options.ignoreChecks) {
      throw new Error(`x${label}:\n  ${problems.join('\n  ')}\n--ignore-checks runs it anyway`);
    }
    console.warn(`Warning: x${label}:\n  ${problems.join('\n  ')}\nRunning anyway (--ignore-checks)`);
  }
  // Before generating (which takes long): the run must not mix with an earlier one's output
  const busy = outputDirs(config).filter(({ dir }) => !outputEmpty(dir));
  if (busy.length > 0) {
    throw new Error(`${busy.map(({ dir }) => Path.relative(experiment, dir)).join(', ')} not empty; ` +
      'move the contents away, they would be mixed with this run\'s');
  }
  console.log(`\n=== x${label}`);
  for (const warning of planned.warnings) {
    console.warn(`Warning: ${warning}`);
  }

  // The point's overrides, next to the base
  const overrides = Path.join(Path.dirname(config.baseOverrides),
    `${Path.basename(config.baseOverrides, '.yaml')}.scale-${label}.yaml`);
  fs.writeFileSync(Path.resolve(experiment, overrides), planned.yaml);

  const undo = applyPoint(config, overrides, entry.settings ?? {});
  let measured;
  let queries;
  let warnings = [ ...planned.warnings ];
  let marker;
  let engines;
  try {
    // -f: generate from scratch (the combinations share it) and reload the databases
    await jbr(config, [ 'prepare', '-f' ]);
    if (interrupted()) {
      throw new Error('Interrupted');
    }
    marker = JSON.parse(fs.readFileSync(Path.join(generated, MARKER), 'utf8'));
    const images = new Set(runs.map(run => run.summary.generatorImageId).filter(Boolean));
    if (images.size > 0 && !images.has(marker.generatorImageId)) {
      const text = `x${label} was generated by ${marker.generatorImageId}, the complete points by ${[ ...images ].join(', ')}`;
      if (!options.ignoreChecks) {
        throw new Error(`${text}: the generator changed; redo the points with --force, or pass --ignore-checks`);
      }
      warnings.push(text);
    }
    engines = engineImages(config, selected);
    const engineChanges = imageChanges(engines, runs);
    if (engineChanges.length > 0) {
      const text = `x${label} would run on another engine than the complete points:\n  ${engineChanges.join('\n  ')}`;
      if (!options.ignoreChecks) {
        throw new Error(`${text}\nRedo the points with --force, or pass --ignore-checks`);
      }
      warnings.push(text);
    }
    console.log('Measuring the federation...');
    measured = measure(generated);
    const wrong = checkGenerated(config, planned.yaml, measured);
    if (wrong.length > 0) {
      throw new Error(`x${label} was not generated as planned (nothing ran):\n  ${wrong.join('\n  ')}`);
    }
    queries = instances(generated, planned.effective.queryInstances ?? []);
    warnings = [ ...warnings, ...compareWithPoints(measured, runs, config.perPod, entry.scale) ];
    if (queries.missing.length > 0) {
      warnings.push(`no instance to run for ${queries.missing.join(', ')}`);
    }
    for (const warning of warnings.slice(planned.warnings.length)) {
      console.warn(`Warning: ${warning}`);
    }
    console.log(`${measured.pods} pods (${Object.entries(measured.kinds).map(([ k, v ]) => `${v.pods} ${k}`).join(', ')}), ` +
      `${measured.triples} triples, ${measured.documents} documents, ${queries.count} query instances`);

    // Run the point's combinations
    if (!selected || selected.length === config.combinations.length) {
      await jbr(config, [ 'run' ]);
    } else {
      for (const { id } of selected) {
        if (interrupted()) {
          throw new Error('Interrupted');
        }
        await jbr(config, [ 'run', '-c', String(id) ]);
      }
    }
  } finally {
    undo();
  }

  // Keep the output under the point's name
  fs.mkdirSync(target, { recursive: true });
  for (const { name: combination, dir } of outputDirs(config, selected)) {
    const kept = combination ? Path.join(target, combination) : target;
    if (combination) {
      fs.renameSync(dir, kept);
      fs.mkdirSync(dir);
      if (fs.existsSync(Path.join(kept, '.keep'))) {
        fs.renameSync(Path.join(kept, '.keep'), Path.join(dir, '.keep'));
      }
      // Which factor values the combination ran with
      fs.copyFileSync(Path.join(experiment, 'combinations', combination, EXPERIMENT_CONFIG), Path.join(kept, EXPERIMENT_CONFIG));
    } else {
      for (const name of fs.readdirSync(dir).filter(n => n !== '.keep')) {
        fs.renameSync(Path.join(dir, name), Path.join(kept, name));
      }
    }
  }
  fs.copyFileSync(Path.resolve(experiment, overrides), Path.join(target, 'overrides.yaml'));
  for (const rel of [ MARKER, `benchmark/${PUBLISHERS}`, 'benchmark/workload-summary.csv' ]) {
    if (fs.existsSync(Path.join(generated, rel))) {
      fs.copyFileSync(Path.join(generated, rel), Path.join(target, Path.basename(rel)));
    }
  }
  fs.writeFileSync(Path.join(target, 'instances.csv'), queries.csv);
  const pointHealth = health(target, selected, planned.effective);
  fs.writeFileSync(Path.join(target, HEALTH), `${JSON.stringify(pointHealth, null, 2)}\n`);
  // The summary last: it marks the directory complete
  fs.writeFileSync(Path.join(target, SUMMARY), `${JSON.stringify({
    label,
    scale: entry.scale,
    scaled: config.scaled,
    perPod: config.perPod,
    knownTarget: config.known,
    overrides: entry.overrides,
    settings: planned.effective,
    combinations: selected?.map(c => ({ name: c.name, ...c.factors })),
    known: entry.known,
    measured,
    queryInstances: queries.count,
    missingTemplates: queries.missing,
    generatorImageId: marker.generatorImageId,
    engineImages: engines,
    warnings,
    finishedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  console.log(`=== x${label}: results in ${target}; up to ${round(pointHealth.maxFailureShare * 100, 1)}% of a combination's ` +
    `executions failed, memory peaked at ${pointHealth.maxMemoryPercent}% of the host's`);
}

// ----- status -----

function printStatus(config) {
  const runs = completedRuns(config.experiment).sort((a, b) => a.summary.scale - b.summary.scale);
  if (runs.length === 0) {
    console.log('No complete points yet');
  }
  for (const run of runs) {
    const s = run.summary;
    const m = s.measured;
    console.log(`\nx${run.label} (${run.name}, ${s.finishedAt})`);
    console.log(`  ${m.pods} pods: ${Object.entries(m.kinds).map(([ k, v ]) => `${v.pods} ${k} (${v.triplesPerPod.mean} triples` +
      (v.documentsPerPod ? `, ${v.documentsPerPod.mean} documents` : '') +
      (KINDS[k] && v[`${KINDS[k]}PerPod`] ? `, ${v[`${KINDS[k]}PerPod`].mean} ${KINDS[k]}` : '') + ' each)').join(', ')}`);
    console.log(`  ${m.triples} triples, ${m.documents} documents, ${round(m.generatedBytes / GiB, 2)} GiB generated; ` +
      `${s.queryInstances} query instances${s.missingTemplates.length > 0 ? `, none for ${s.missingTemplates.join(', ')}` : ''}`);
    for (const [ name, c ] of Object.entries(run.health.combinations)) {
      const values = Object.entries(c).filter(([ , v ]) => typeof v === 'string').map(([ , v ]) => v).join('/');
      console.log(`  ${name} ${values}: ${c.failed}/${c.executions} failed (${c.errors} errors, ${c.incomplete} incomplete, ` +
        `${c.atTimeout} at the timeout), memory ${c.memoryPercentSum}% of the host` +
        (c.enginePeakOfHeap === undefined ? '' : `, engine ${round(c.enginePeakOfHeap * 100, 1)}% of its heap`));
    }
    for (const warning of s.warnings) {
      console.log(`  warning: ${warning}`);
    }
  }
  for (const point of config.points.filter(p => p.gate)) {
    const gateRun = runs.find(run => run.label === point.gate.point);
    const problems = gateRun ? gateProblems(point.gate, gateRun.health) : [ `x${point.gate.point} has not run yet` ];
    console.log(`\nGate of x${point.label} (x${point.gate.point}, at most ${point.gate.maxFailureShare * 100}% failed, ` +
      `${point.gate.maxMemoryPercent}% memory): ${problems.length === 0 ? 'passes' : `does not pass\n  ${problems.join('\n  ')}`}`);
  }
}

// ----- commands -----

/** The one vary-*.json in a directory. */
function defaultConfig(dir) {
  const names = fs.readdirSync(dir).filter(name => CONFIG_PATTERN.test(name)).sort();
  if (names.length !== 1) {
    throw new Error(names.length === 0 ?
      `No vary-*.json in ${dir}: name the config` :
      `Several configs in ${dir} (${names.join(', ')}): name the one to use`);
  }
  return Path.join(dir, names[0]);
}

function parseArgs(argv) {
  const positional = [];
  const options = { force: false, ignoreGate: false, ignoreChecks: false, include: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--force') {
      options.force = true;
    } else if (arg === '--ignore-gate') {
      options.ignoreGate = true;
    } else if (arg === '--ignore-checks') {
      options.ignoreChecks = true;
    } else if (arg === '--include' || arg.startsWith('--include=')) {
      const value = arg === '--include' ? argv[++i] : arg.slice('--include='.length);
      if (!value) {
        throw new Error('--include needs a point label, such as --include 4');
      }
      for (const label of value.split(',').map(l => l.replace(/^x/u, '').trim()).filter(Boolean)) {
        options.include.add(label);
      }
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { command: positional[0], configArg: positional[1], options };
}

async function main() {
  const { command, configArg, options } = parseArgs(process.argv.slice(2));
  if (![ 'plan', 'run', 'status' ].includes(command)) {
    throw new Error('Usage: npm run vary -- <plan|run|status> [config] [--include <labels>] [--force] [--ignore-gate] [--ignore-checks]');
  }
  const config = loadConfig(Path.resolve(configArg ?? defaultConfig(process.cwd())));
  const unknown = [ ...options.include ].filter(label => !config.points.some(p => p.label === label));
  if (unknown.length > 0) {
    throw new Error(`--include: no point ${unknown.join(', ')} (points: ${config.points.map(p => p.label).join(', ')})`);
  }
  if (command === 'status') {
    printStatus(config);
    return;
  }
  const planned = plan(config);
  writePlan(config, planned);
  printPlan(config, planned);
  if (command === 'plan') {
    return;
  }

  let interrupted = false;
  process.on('SIGINT', () => {
    interrupted = true;
  });
  // Smallest first: a larger point's gate and disk estimate need the smaller ones
  for (const point of [ ...planned ].sort((a, b) => a.entry.scale - b.entry.scale)) {
    if (interrupted) {
      throw new Error('Interrupted');
    }
    await runPoint(config, point, options, () => interrupted);
  }
  console.log('\nDone. npm run vary -- status shows every point.');
}

if (require.main === module) {
  main().catch(error => {
    console.error(`\n${error.message || error}`);
    process.exit(1);
  });
}

module.exports = {
  brandSizes, pyRound, readSection, readKey, hasKey, setKey, generatorSettings, feasibility, knownMembers,
  scaleOverrides, factorCombinations, selectCombinations, measure, instances, health, gateProblems, checkGenerated,
  compareWithPoints, memoryEstimate, parseArgs, effectiveSettings, loadConfig, plan, imageChanges, defaultConfig,
};
