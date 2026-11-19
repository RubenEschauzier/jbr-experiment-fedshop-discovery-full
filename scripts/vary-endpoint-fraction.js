#!/usr/bin/env node
// Runs a fedshop-discovery jbr experiment once per fraction of the discoverable publishers with a SPARQL
// endpoint (the generator's `services` section), regenerating the benchmark for every fraction and keeping
// each run's output in output-<fraction>/. Before running, it checks that the data and the queries are
// byte-identical to those of every earlier fraction (output-*/fingerprint.json), so that only the
// endpoints differ between runs, and that the endpoints are nested: a larger fraction keeps every
// endpoint of a smaller one.
//
// Usage: npm run vary -- <plan|run> [config] [--force]
//   (or: node scripts/vary-endpoint-fraction.js <plan|run> [config] [--force])
//   plan   write into the config what every fraction means for the brands' products
//   run    plan, then per fraction: remove the previous generation, jbr prepare, check, jbr run, move
//          the output to output-<fraction>/. Fractions whose output-<fraction>/ is complete are skipped;
//          --force redoes them.
// The config defaults to ./vary-endpoint-fraction.json; the experiment is the config's directory
// unless the config names another one (`experiment`). In a combination-based experiment
// (jbr-combinations.json, with commonGenerated) every fraction is generated once and run for every
// combination: output-<fraction>/combination_<i>/ holds each combination's output. Only Node's own
// modules are used.
'use strict';
const Path = require('node:path');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');

const CONFIG_NAME = 'vary-endpoint-fraction.json';
const EXPERIMENT_CONFIG = 'jbr-experiment.json';
/** What this script writes into output-<fraction>/ last: a directory without it is an incomplete run. */
const SUMMARY = 'endpoint-fraction.json';
const FINGERPRINT = 'fingerprint.json';
const PUBLISHERS = 'publishers.json';
/** What generation writes into generated/; the hook's own files are left alone. */
const GENERATED_PARTS = [
  'benchmark', 'logs', 'queries', 'overrides.yaml', 'jbr-overrides.yaml', 'proxy-run.json', 'fedshop-discovery.json',
];
/** The line of a storage root's .meta that names its endpoint: the one thing a fraction may change in the documents. */
const VOID_ENDPOINT = '<http://rdfs.org/ns/void#sparqlEndpoint>';
/** The fields of publishers.json that follow from the fraction; every other field must stay the same. */
const SERVICE_FIELDS = [ 'service', 'port', 'endpoint' ];
/** The generator's services section: its keys per kind, what a publisher's size counts, and its defaults. */
const KINDS = {
  brands: { kind: 'producer', size: 'products' },
  shops: { kind: 'vendor', size: 'offers' },
  review_sites: { kind: 'ratingsite', size: 'reviews' },
};
const SELECTIONS = [ 'largest', 'data' ];
const SERVICES_DEFAULTS = { select: 'largest', brands: 0.25, shops: 1, review_sites: 1, seed: 42 };

// ----- reading and writing the overrides -----
// The script reads YAML no further than a top-level section's `key: value` lines (block or flow style).

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

/** A top-level section's scalar values, as strings, or undefined if there is none. */
function readSection(yaml, name) {
  const lines = yaml.split('\n');
  const range = sectionLines(lines, name);
  if (!range) {
    return undefined;
  }
  const values = {};
  const head = lines[range[0]].replace(/\s+#.*$/u, '');
  const flow = /\{(.*)\}/u.exec(head);
  if (flow) {
    for (const match of flow[1].matchAll(/(\w+):\s*([^,{}\s]+)/gu)) {
      values[match[1]] = match[2];
    }
    return values;
  }
  for (const line of lines.slice(range[0] + 1, range[1])) {
    const match = /^ {1,4}(\w+):\s*([^\s#]+)/u.exec(line);
    if (match) {
      values[match[1]] = match[2];
    }
  }
  return values;
}

/** The overrides with their services section replaced by the given one (appended at the end). */
function withServices(yaml, services) {
  const lines = yaml.replace(/\n*$/u, '').split('\n');
  const range = sectionLines(lines, 'services');
  if (range) {
    lines.splice(range[0], range[1] - range[0]);
  }
  return [
    ...lines,
    'services:                      # written by scripts/vary-endpoint-fraction.js for this fraction',
    ...Object.entries(services).map(([ key, value ]) => `  ${key}: ${value}`),
    '',
  ].join('\n');
}

/** The base overrides' services section over the generator's defaults. */
function baseServices(yaml, file) {
  if (readSection(yaml, 'brands')?.service_share !== undefined) {
    throw new Error(`${file} sets brands.service_share, which the generator no longer reads: set services.brands instead`);
  }
  const section = readSection(yaml, 'services') ?? {};
  return {
    select: section.select ?? SERVICES_DEFAULTS.select,
    brands: Number(section.brands ?? SERVICES_DEFAULTS.brands),
    shops: Number(section.shops ?? SERVICES_DEFAULTS.shops),
    review_sites: Number(section.review_sites ?? SERVICES_DEFAULTS.review_sites),
    seed: section.seed ?? SERVICES_DEFAULTS.seed,
  };
}

/** The services section of one fraction: the varied kinds get the fraction, the others keep the base's. */
function servicesFor(config, fraction) {
  const services = { ...config.base, select: config.select };
  for (const key of config.kinds) {
    services[key] = fraction;
  }
  return services;
}

// ----- planning -----

/**
 * Products per brand, largest first: fedshop/discovery/catalog.py brand_sizes, in the same floating-point
 * operations (the generator's Python 3.8 sums floats left to right, as reduce does).
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

/**
 * What a fraction means for the brands. With select largest that is exact: the largest
 * round(share * count) brands (sizes are largest first). With select data the share of the products is
 * the target itself; the generator reaches it within one brand, and run records what it reached.
 */
function planFraction(config, fraction, brands) {
  const services = servicesFor(config, fraction);
  const entry = { fraction };
  if (config.select === 'largest') {
    const sizes = brandSizes(brands.products, brands.count, brands.zipf, brands.minProducts);
    const withEndpoint = pyRound(services.brands * brands.count);
    const products = sizes.slice(0, withEndpoint).reduce((sum, s) => sum + s, 0);
    Object.assign(entry, {
      brandsWithEndpoint: withEndpoint,
      brands: brands.count,
      productsWithEndpoint: products,
      products: brands.products,
      productFraction: round(products / brands.products),
    });
  } else {
    entry.productFractionTarget = services.brands;
  }
  if (config.kinds.some(key => key !== 'brands')) {
    entry.memberFractionTarget = Object.fromEntries(config.kinds.filter(key => key !== 'brands').map(key => [ key, fraction ]));
  }
  return entry;
}

function readBrands(yaml, file) {
  const brands = readSection(yaml, 'brands') ?? {};
  for (const key of [ 'products', 'count', 'zipf', 'min_products' ]) {
    if (brands[key] === undefined) {
      throw new Error(`${file} must set brands.${key} (the script plans from the overrides, not the image's defaults)`);
    }
  }
  return {
    products: Number(brands.products),
    count: Number(brands.count),
    zipf: Number(brands.zipf),
    minProducts: Number(brands.min_products),
  };
}

function plan(config) {
  const brands = readBrands(fs.readFileSync(config.baseOverridesPath, 'utf8'), config.baseOverridesPath);
  return config.fractions.map(fraction => planFraction(config, fraction, brands));
}

function round(x) {
  return Math.round(x * 1e6) / 1e6;
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
  const select = raw.select ?? 'data';
  if (!SELECTIONS.includes(select)) {
    throw new Error(`select must be one of ${SELECTIONS.join(', ')}, not ${JSON.stringify(select)}`);
  }
  const kinds = raw.kinds ?? Object.keys(KINDS);
  if (!Array.isArray(kinds) || kinds.length === 0 || kinds.some(key => !(key in KINDS)) || new Set(kinds).size !== kinds.length) {
    throw new Error(`kinds must list some of ${Object.keys(KINDS).join(', ')}`);
  }
  const fractions = (raw.fractions ?? []).map(f => typeof f === 'number' ? f : f.fraction);
  if (fractions.length === 0 || fractions.some(f => typeof f !== 'number' || !(f >= 0 && f <= 1))) {
    throw new Error('fractions must list fractions between 0 and 1');
  }
  const labels = fractions.map(label);
  if (new Set(labels).size !== labels.length) {
    throw new Error(`fractions must be distinct: ${labels.join(', ')}`);
  }
  const baseOverrides = raw.baseOverrides ?? 'input/discovery-overrides.yaml';
  const baseOverridesPath = Path.resolve(experiment, baseOverrides);
  return {
    path: configPath,
    raw,
    experiment,
    combinations,
    select,
    kinds,
    baseOverrides,
    baseOverridesPath,
    base: baseServices(fs.readFileSync(baseOverridesPath, 'utf8'), baseOverridesPath),
    jbr: raw.jbr ?? [ 'npm', 'run', 'jbr', '--' ],
    dataDigest: raw.dataDigest,
    fractions,
  };
}

/**
 * The combinations of a combination-based experiment (combinations/combination_<i>, in jbr's order), or
 * undefined for an experiment with one jbr-experiment.json. Its combinations must share generated/
 * (commonGenerated): a fraction is one generation, which every combination runs against.
 */
function readCombinations(experiment) {
  const file = Path.join(experiment, 'jbr-combinations.json');
  if (!fs.existsSync(file)) {
    return undefined;
  }
  if (JSON.parse(fs.readFileSync(file, 'utf8')).commonGenerated !== true) {
    throw new Error(`${file} must set "commonGenerated": true, so that every combination runs against the same generation`);
  }
  const dir = Path.join(experiment, 'combinations');
  const combinations = (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
    .filter(name => /^combination_\d+$/u.test(name) && fs.existsSync(Path.join(dir, name, EXPERIMENT_CONFIG)))
    .sort((a, b) => Number(a.split('_')[1]) - Number(b.split('_')[1]));
  if (combinations.length === 0) {
    throw new Error(`No combinations/combination_*/${EXPERIMENT_CONFIG}: run npm run jbr -- generate-combinations first`);
  }
  return combinations;
}

/** The jbr-experiment.json files of the experiment: one, or one per combination. */
function experimentConfigs(config) {
  return config.combinations ?
    config.combinations.map(name => Path.join(config.experiment, 'combinations', name, EXPERIMENT_CONFIG)) :
    [ Path.join(config.experiment, EXPERIMENT_CONFIG) ];
}

/** Where jbr run writes: output/, or each combination's output/, with the name it gets in output-<fraction>/. */
function outputDirs(config) {
  return config.combinations ?
    config.combinations.map(name => ({ name, dir: Path.join(config.experiment, 'combinations', name, 'output') })) :
    [ { name: undefined, dir: Path.join(config.experiment, 'output') } ];
}

/** Write the plan into the config, so the config shows what every fraction means. */
function writePlan(config, planned) {
  const raw = { ...config.raw, select: config.select, kinds: config.kinds, fractions: planned };
  fs.writeFileSync(config.path, `${JSON.stringify(raw, null, 2)}\n`);
}

function label(fraction) {
  return String(fraction);
}

function printPlan(config, planned) {
  const fixed = Object.keys(KINDS).filter(key => !config.kinds.includes(key));
  console.log(`select ${config.select}, varying ${config.kinds.join(', ')}` +
    (fixed.length > 0 ? `; fixed: ${fixed.map(key => `${key} ${config.base[key]}`).join(', ')}` : ''));
  for (const p of planned) {
    const brands = config.select === 'largest' ?
      `${p.brandsWithEndpoint}/${p.brands} brands, ${(p.productFraction * 100).toFixed(2)}% of the products (${p.productsWithEndpoint}/${p.products})` :
      `brands holding at least ${(p.productFractionTarget * 100).toFixed(2)}% of the products`;
    const members = p.memberFractionTarget ?
      `; ${Object.keys(p.memberFractionTarget).join(', ')}: ${config.select === 'largest' ? 'the largest' : 'holding at least'} ` +
      `${(p.fraction * 100).toFixed(2)}%${config.select === 'largest' ? '' : ' of their offers or reviews'}` :
      '';
    console.log(`  ${label(p.fraction).padEnd(8)} ${brands}${members}`);
  }
}

// ----- fingerprint -----

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** Files under a directory, relative to it, sorted. */
function walk(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(Path.join(dir, prefix), { withFileTypes: true })
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...walk(dir, rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

/** A storage root's .meta without the line naming its endpoint. */
function metaWithoutEndpoint(text) {
  return text.split('\n').filter(line => !line.includes(VOID_ENDPOINT)).join('\n');
}

/**
 * Hashes of what must not depend on the fraction, relative to generated/:
 * - data: every publisher's graph (benchmark/data), the placements, links and categories;
 * - documents: every storage's documents (benchmark/web/<storage>/, one hash per storage), with each
 *   .meta compared without its void:sparqlEndpoint line;
 * - publishers: publishers.json without the fields that follow from the fraction (service, port, endpoint);
 * - queries: every instance's queries, reference answers and reachable answers, the known endpoints
 *   (benchmark/sources/known-*) and the query sets with their contexts (queries/*.json).
 * Not compared: Virtuoso's load scripts, serving.json, discoverable-storages.tsv and the workload analysis
 * (analysis.json, workload-summary.csv), which name or count the discovered endpoints.
 */
function fingerprint(generated) {
  const benchmark = Path.join(generated, 'benchmark');
  const entries = {};
  const add = (rel, data) => {
    entries[rel] = sha256(data);
  };
  const file = rel => fs.readFileSync(Path.join(generated, rel));

  for (const rel of walk(Path.join(benchmark, 'data'))) {
    add(`benchmark/data/${rel}`, file(`benchmark/data/${rel}`));
  }
  for (const rel of [ 'placements.nq', 'links.tsv', 'categories.json' ]) {
    add(`benchmark/${rel}`, file(`benchmark/${rel}`));
  }

  const web = Path.join(benchmark, 'web');
  const storages = {};
  for (const rel of walk(web)) {
    const slash = rel.indexOf('/');
    let content = fs.readFileSync(Path.join(web, rel));
    if (Path.basename(rel) === '.meta') {
      content = metaWithoutEndpoint(content.toString('utf8'));
    }
    if (slash < 0) {
      add(`benchmark/web/${rel}`, content);
    } else {
      (storages[rel.slice(0, slash)] ||= []).push(`${rel.slice(slash + 1)}\0${sha256(content)}\n`);
    }
  }
  for (const [ storage, lines ] of Object.entries(storages)) {
    add(`benchmark/web/${storage}/`, lines.join(''));
  }

  const publishers = JSON.parse(file(`benchmark/${PUBLISHERS}`).toString('utf8'));
  for (const info of Object.values(publishers)) {
    for (const field of SERVICE_FIELDS) {
      delete info[field];
    }
  }
  add(`benchmark/${PUBLISHERS} (without ${SERVICE_FIELDS.join(', ')})`, JSON.stringify(publishers));

  for (const rel of walk(Path.join(benchmark, 'workload'))) {
    if (/^q\d+\/instance_\d+\/(injected\.sparql|plain\.sparql|results\.csv|plain-results\.csv|reachable\.csv)$/u.test(rel)) {
      add(`benchmark/workload/${rel}`, file(`benchmark/workload/${rel}`));
    }
  }
  for (const rel of [ 'benchmark/sources/known-endpoints.tsv', 'benchmark/sources/known-fedx.ttl', 'queries/plain.json', 'queries/service.json' ]) {
    add(rel, file(rel));
  }

  const keys = Object.keys(entries).sort();
  const sorted = Object.fromEntries(keys.map(key => [ key, entries[key] ]));
  const groups = { data: [], documents: [], queries: [] };
  for (const key of keys) {
    const group = key.startsWith('benchmark/web/') ? 'documents' :
      /^benchmark\/(workload|sources)\/|^queries\//u.test(key) ? 'queries' : 'data';
    groups[group].push(`${key}\0${sorted[key]}\n`);
  }
  return {
    digest: sha256(keys.map(key => `${key}\0${sorted[key]}\n`).join('')),
    digests: Object.fromEntries(Object.entries(groups).map(([ group, lines ]) => [ group, sha256(lines.join('')) ])),
    files: keys.length,
    entries: sorted,
  };
}

/** Differences between two fingerprints, as lines. */
function differences(expected, actual) {
  const out = [];
  for (const key of new Set([ ...Object.keys(expected.entries), ...Object.keys(actual.entries) ])) {
    if (!(key in actual.entries)) {
      out.push(`missing: ${key}`);
    } else if (!(key in expected.entries)) {
      out.push(`extra:   ${key}`);
    } else if (expected.entries[key] !== actual.entries[key]) {
      out.push(`differs: ${key}`);
    }
  }
  return out.sort();
}

/** The earlier complete runs: output-<fraction>/ with its summary, fingerprint and publishers. */
function completedRuns(experiment) {
  return fs.readdirSync(experiment)
    .filter(name => /^output-.+/u.test(name) && fs.existsSync(Path.join(experiment, name, SUMMARY)))
    .map(name => {
      const read = file => JSON.parse(fs.readFileSync(Path.join(experiment, name, file), 'utf8'));
      return { name, summary: read(SUMMARY), fingerprint: read(FINGERPRINT), publishers: read(PUBLISHERS) };
    });
}

// ----- measuring what was generated -----

/** The publishers with an endpoint, among those the fraction chooses (discoverable brands, shops, review sites). */
function endpointSet(publishers) {
  const kinds = new Set(Object.values(KINDS).map(k => k.kind));
  return new Set(Object.entries(publishers)
    .filter(([ , info ]) => kinds.has(info.kind) && !info.known && info.service)
    .map(([ name ]) => name));
}

/**
 * The endpoints as generated, from publishers.json: per kind, the discoverable publishers with an endpoint
 * and the share of the kind's products, offers or reviews they hold; the share of all discoverable
 * triples behind an endpoint; and the share of the products shops and review sites deal in (the catalog's
 * first members.pool products) whose brand has an endpoint, counted from the brands' graphs.
 */
function measure(generated) {
  const benchmark = Path.join(generated, 'benchmark');
  const publishers = JSON.parse(fs.readFileSync(Path.join(benchmark, PUBLISHERS), 'utf8'));
  const result = {};
  for (const [ key, { kind, size } ] of Object.entries(KINDS)) {
    const all = Object.values(publishers).filter(info => info.kind === kind);
    const discoverable = all.filter(info => !info.known);
    const withEndpoint = discoverable.filter(info => info.service);
    const total = discoverable.reduce((sum, info) => sum + info[size], 0);
    const covered = withEndpoint.reduce((sum, info) => sum + info[size], 0);
    result[key] = {
      known: all.length - discoverable.length,
      discoverable: discoverable.length,
      discoverableWithEndpoint: withEndpoint.length,
      [size]: total,
      [`${size}WithEndpoint`]: covered,
      fraction: total > 0 ? round(covered / total) : 0,
    };
  }
  const discoverable = Object.values(publishers).filter(info => !info.known);
  const triples = discoverable.reduce((sum, info) => sum + info.triples, 0);
  result.discoverableTriples = triples;
  result.discoverableTriplesWithEndpoint = discoverable.filter(info => info.service).reduce((sum, info) => sum + info.triples, 0);
  result.discoverableTripleFraction = round(result.discoverableTriplesWithEndpoint / triples);

  const pool = readPool(generated);
  if (pool !== undefined) {
    // A product's subject ends in Product<n>, whatever the brand's layout (per-product or by-month)
    const productNumbers = info => new Set([ ...fs.readFileSync(Path.join(benchmark, 'data', info.file), 'utf8')
      .matchAll(/^<[^>]*[/#]Product(\d+)(?:#it)?> /gmu) ].map(m => Number(m[1])));
    let inPool = 0;
    let inPoolWithEndpoint = 0;
    let consistent = true;
    for (const info of Object.values(publishers).filter(i => i.kind === 'producer')) {
      const numbers = productNumbers(info);
      consistent &&= numbers.size === info.products;
      const n = [ ...numbers ].filter(number => number < pool).length;
      inPool += n;
      inPoolWithEndpoint += info.service ? n : 0;
    }
    if (consistent && inPool === pool) {
      result.brands.poolProducts = pool;
      result.brands.poolProductsWithEndpoint = inPoolWithEndpoint;
      result.brands.poolFraction = round(inPoolWithEndpoint / pool);
    } else {
      console.warn('Could not count the brands\' products in the members\' pool from their graphs; poolFraction is left out');
    }
  }
  return { publishers, result };
}

/** members.pool from the overrides generation used, if it sets it. */
function readPool(generated) {
  const pool = readSection(fs.readFileSync(Path.join(generated, 'overrides.yaml'), 'utf8'), 'members')?.pool;
  return pool === undefined ? undefined : Number(pool);
}

/**
 * Per selected instance: the discoverable publishers its answer needs (the workload analysis'
 * storages_needed), how many of them have an endpoint, and which share of their triples.
 */
function coverage(generated, publishers) {
  const lines = fs.readFileSync(Path.join(generated, 'benchmark', 'workload-summary.csv'), 'utf8').split('\n');
  const header = parseCsvLine(lines[0]);
  const rows = [ 'query,instance,kind,discoverable_needed,with_endpoint,publisher_fraction,triple_fraction' ];
  for (const line of lines.slice(1).filter(Boolean)) {
    const row = Object.fromEntries(parseCsvLine(line).map((value, i) => [ header[i], value ]));
    if (row.selected !== 'True') {
      continue;
    }
    const needed = (row.storages_needed ?? '').split(' ').filter(name => publishers[name] && !publishers[name].known);
    const covered = needed.filter(name => publishers[name].service);
    const triples = names => names.reduce((sum, name) => sum + publishers[name].triples, 0);
    rows.push([
      row.query, row.instance, row.kind, needed.length, covered.length,
      needed.length > 0 ? round(covered.length / needed.length) : '',
      needed.length > 0 ? round(triples(covered) / triples(needed)) : '',
    ].join(','));
  }
  return `${rows.join('\n')}\n`;
}

/** One line of Python's csv output (quoted fields with doubled quotes). */
function parseCsvLine(line) {
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
    } else if (c === ',') {
      out.push(field);
      field = '';
    } else {
      field += c.replace('\r', '');
    }
  }
  out.push(field);
  return out;
}

// ----- checks -----

/** The data and queries are byte-identical to every earlier fraction's (and to dataDigest, if set). */
function checkFingerprint(config, runs, print) {
  const mismatches = [];
  if (config.dataDigest && config.dataDigest !== print.digest) {
    mismatches.push(`dataDigest in the config is ${config.dataDigest}, generated ${print.digest}`);
  }
  for (const run of runs) {
    if (run.fingerprint.digest !== print.digest) {
      const diff = differences(run.fingerprint, print);
      mismatches.push(`differs from ${run.name} in ${diff.length} entries:\n  ${diff.slice(0, 25).join('\n  ')}` +
        (diff.length > 25 ? `\n  ... (${diff.length - 25} more)` : ''));
    }
  }
  return mismatches;
}

/**
 * The endpoints are nested with every earlier fraction's: a smaller fraction's are a subset, a larger one's
 * a superset. Returns the problems, and warns when an earlier fraction has the very same endpoints.
 */
function checkNested(fraction, endpoints, runs) {
  const problems = [];
  for (const run of runs) {
    const other = endpointSet(run.publishers);
    const otherFraction = run.summary.fraction;
    const [ small, large, smallName, largeName ] = otherFraction <= fraction ?
      [ other, endpoints, run.name, 'this fraction' ] :
      [ endpoints, other, 'this fraction', run.name ];
    const missing = [ ...small ].filter(name => !large.has(name));
    if (missing.length > 0) {
      problems.push(`${largeName} lacks endpoints that ${smallName} has: ${missing.slice(0, 10).join(', ')}` +
        (missing.length > 10 ? ` ... (${missing.length} in all)` : ''));
    } else if (small.size === large.size) {
      console.warn(`Warning: ${run.name} has the very same ${endpoints.size} endpoints as this fraction`);
    }
  }
  return problems;
}

/** Earlier runs must come from the same design: the same selection, varied kinds and fixed values. */
function checkDesign(config, runs) {
  const design = JSON.stringify({ select: config.select, kinds: config.kinds, base: config.base });
  const others = runs.filter(run => JSON.stringify(run.summary.design) !== design);
  if (others.length > 0) {
    throw new Error(`${others.map(run => run.name).join(', ')} come from another design (select, kinds or the base ` +
      'overrides\' services differ): move them out of the experiment, or redo them with --force');
  }
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

/**
 * Point a jbr-experiment.json's configOverrides at a file, changing nothing else in it. Returns the
 * value it had.
 */
function setConfigOverrides(file, value) {
  const text = fs.readFileSync(file, 'utf8');
  const pattern = /("configOverrides"\s*:\s*)"([^"]*)"/u;
  const match = pattern.exec(text);
  if (!match || (text.match(/"configOverrides"/gu) ?? []).length !== 1) {
    throw new Error(`${file} must set configOverrides exactly once`);
  }
  fs.writeFileSync(file, text.replace(pattern, `$1${JSON.stringify(value)}`));
  return match[2];
}

/** Whether output/ holds nothing but jbr's .keep. */
function outputEmpty(output) {
  return !fs.existsSync(output) || fs.readdirSync(output).every(name => name === '.keep');
}

async function runFraction(config, planned, force) {
  const name = label(planned.fraction);
  const experiment = config.experiment;
  const generated = Path.join(experiment, 'generated');
  const outputs = outputDirs(config);
  const target = Path.join(experiment, `output-${name}`);

  if (fs.existsSync(Path.join(target, SUMMARY)) && !force) {
    console.log(`\n=== fraction ${name}: already done in ${Path.basename(target)}, skipped (--force redoes it)`);
    return;
  }
  if (fs.existsSync(target)) {
    if (!force) {
      throw new Error(`${target} exists but is incomplete (no ${SUMMARY}); remove it or pass --force`);
    }
    fs.rmSync(target, { recursive: true, force: true });
  }
  const runs = completedRuns(experiment);
  checkDesign(config, runs);
  // Before generating (which takes long): the run must not mix with an earlier one's output
  const busy = outputs.filter(({ dir }) => !outputEmpty(dir));
  if (busy.length > 0) {
    throw new Error(`${busy.map(({ dir }) => Path.relative(experiment, dir)).join(', ')} not empty; ` +
      'move the contents away, they would be mixed with this run\'s');
  }
  console.log(`\n=== fraction ${name}`);

  // The fraction's overrides, next to the base
  const services = servicesFor(config, planned.fraction);
  const overrides = Path.join(Path.dirname(config.baseOverrides),
    `${Path.basename(config.baseOverrides, '.yaml')}.endpoints-${name}.yaml`);
  fs.writeFileSync(Path.resolve(experiment, overrides), withServices(fs.readFileSync(config.baseOverridesPath, 'utf8'), services));

  // Remove the previous generation: prepare then generates from scratch (it also recreates the databases)
  for (const part of GENERATED_PARTS) {
    fs.rmSync(Path.join(generated, part), { recursive: true, force: true });
  }
  // Every combination points at the fraction's overrides (with commonGenerated, the first one generates)
  const previous = [];
  try {
    for (const file of experimentConfigs(config)) {
      previous.push([ file, setConfigOverrides(file, overrides) ]);
    }
    await jbr(config, [ 'prepare' ]);
  } finally {
    for (const [ file, value ] of previous) {
      setConfigOverrides(file, value);
    }
  }

  // Generated as planned?
  const { publishers, result } = measure(generated);
  if (config.select === 'largest' &&
    (result.brands.discoverableWithEndpoint !== planned.brandsWithEndpoint || result.brands.productsWithEndpoint !== planned.productsWithEndpoint)) {
    throw new Error(`Generated ${result.brands.discoverableWithEndpoint} brands with ${result.brands.productsWithEndpoint} products ` +
      `with an endpoint, planned ${planned.brandsWithEndpoint} with ${planned.productsWithEndpoint}`);
  }
  if (config.select === 'data') {
    for (const key of Object.keys(KINDS)) {
      if (result[key].fraction < services[key] - 1e-9) {
        throw new Error(`Generated ${key} hold ${result[key].fraction} of their data behind an endpoint, less than ${services[key]}`);
      }
    }
  }

  // The same data and queries as every earlier fraction, and nested endpoints
  console.log('Fingerprinting the data and queries...');
  const print = fingerprint(generated);
  const mismatches = checkFingerprint(config, runs, print);
  if (mismatches.length > 0) {
    const kept = Path.join(experiment, `fingerprint-mismatch-${name}.json`);
    fs.writeFileSync(kept, JSON.stringify(print, null, 1));
    throw new Error(`The data or queries of fraction ${name} are not byte-identical (fingerprint in ${kept}):\n${mismatches.join('\n')}`);
  }
  console.log(`Data and queries identical to earlier fractions (digest ${print.digest}, ${print.files} entries)`);
  const endpoints = endpointSet(publishers);
  const nesting = checkNested(planned.fraction, endpoints, runs);
  if (nesting.length > 0) {
    throw new Error(`The endpoints of fraction ${name} are not nested with earlier fractions':\n${nesting.join('\n')}`);
  }
  console.log(`${endpoints.size} discoverable publishers with an endpoint, nested with ${runs.length} earlier fraction(s)`);
  for (const key of Object.keys(KINDS)) {
    console.log(`  ${key}: ${result[key].discoverableWithEndpoint}/${result[key].discoverable}, ` +
      `${(result[key].fraction * 100).toFixed(2)}% of their ${KINDS[key].size}`);
  }

  // Run (every combination), then keep the output under the fraction's name
  await jbr(config, [ 'run' ]);
  if (config.combinations) {
    fs.mkdirSync(target);
  }
  for (const { name: combination, dir } of outputs) {
    const kept = combination ? Path.join(target, combination) : target;
    fs.renameSync(dir, kept);
    fs.mkdirSync(dir);
    if (fs.existsSync(Path.join(kept, '.keep'))) {
      fs.renameSync(Path.join(kept, '.keep'), Path.join(dir, '.keep'));
    }
    if (combination) {
      // Which factor values the combination ran with
      fs.copyFileSync(Path.join(experiment, 'combinations', combination, EXPERIMENT_CONFIG), Path.join(kept, EXPERIMENT_CONFIG));
    }
  }

  // What generated it, and the summary last (it marks the directory complete)
  fs.copyFileSync(Path.resolve(experiment, overrides), Path.join(target, 'overrides.yaml'));
  for (const rel of [ 'fedshop-discovery.json', `benchmark/${PUBLISHERS}`, 'benchmark/workload-summary.csv' ]) {
    if (fs.existsSync(Path.join(generated, rel))) {
      fs.copyFileSync(Path.join(generated, rel), Path.join(target, Path.basename(rel)));
    }
  }
  fs.writeFileSync(Path.join(target, 'coverage.csv'), coverage(generated, publishers));
  fs.writeFileSync(Path.join(target, FINGERPRINT), JSON.stringify(print, null, 1));
  fs.writeFileSync(Path.join(target, SUMMARY), `${JSON.stringify({
    fraction: planned.fraction,
    design: { select: config.select, kinds: config.kinds, base: config.base },
    combinations: config.combinations,
    services,
    endpoints: endpoints.size,
    ...result,
    dataDigest: print.digest,
    digests: print.digests,
    finishedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  console.log(`=== fraction ${name}: results in ${target}`);
}

// ----- commands -----

async function main() {
  const args = process.argv.slice(2);
  const [ command, configArg ] = args.filter(a => !a.startsWith('--'));
  const force = args.includes('--force');
  const configPath = Path.resolve(configArg ?? CONFIG_NAME);

  if (command !== 'plan' && command !== 'run') {
    throw new Error('Usage: npm run vary -- <plan|run> [config] [--force]');
  }

  const config = loadConfig(configPath);
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
  // Smallest first, so every check compares with the fractions below it as soon as possible
  for (const fraction of [ ...planned ].sort((a, b) => a.fraction - b.fraction)) {
    if (interrupted) {
      throw new Error('Interrupted');
    }
    await runFraction(config, fraction, force);
  }
  console.log(`\nDone: ${planned.map(p => `output-${label(p.fraction)}`).join(', ')}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`\n${error.message || error}`);
    process.exit(1);
  });
}

module.exports = {
  brandSizes, pyRound, readSection, withServices, baseServices, servicesFor, fingerprint, measure, coverage,
  differences, endpointSet, checkNested,
};
