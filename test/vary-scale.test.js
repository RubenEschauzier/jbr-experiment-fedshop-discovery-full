'use strict';
// Unit tests of scripts/vary-scale.js: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const Path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const s = require('../scripts/vary-scale.js');

const BASE = fs.readFileSync(Path.join(__dirname, '..', 'input', 'discovery-overrides.yaml'), 'utf8');
const A2 = {
  scaled: {
    'brands.count': 'scale',
    'brands.products': 'scale',
    'members.shops': 'discoverable',
    'members.review_sites': 'discoverable',
    'members.pool': 'members',
  },
  known: { shops: 10, review_sites: 10 },
};
const A3 = {
  scaled: {
    'members.offers': 'scale',
    'members.reviews': 'scale',
    'members.reviews_per_reviewer': 'scale',
    'brands.products': 'scale',
    'brands.min_products': 'scale',
  },
  known: { shops: 10, review_sites: 10 },
};

test('setKey changes one value and keeps the comment and the other lines', () => {
  const yaml = 'members:\n  shops: 20 # shops\n  pool: 10000\nbrands:\n  count: 400\n';
  assert.equal(s.setKey(yaml, 'members.pool', 5000), 'members:\n  shops: 20 # shops\n  pool: 5000\nbrands:\n  count: 400\n');
  assert.equal(s.readKey(s.setKey(yaml, 'brands.count', 800), 'brands.count'), '800');
  assert.throws(() => s.setKey(yaml, 'members.offers', 1), /do not set members.offers/u);
  assert.ok(s.hasKey(yaml, 'members.shops'));
  assert.ok(!s.hasKey(yaml, 'brands.shops'));
});

test('the known members are those publishing.choose_known chooses', () => {
  // 5 markets; member i is in market i mod 5
  assert.deepEqual(s.knownMembers(20, 5, 0.5).perMarket, [ 2, 2, 2, 2, 2 ]);
  assert.equal(s.knownMembers(15, 5, 2 / 3).known, 10);
  assert.equal(s.knownMembers(50, 5, 0.2).known, 10);
  // round half to even: 0.5 * 3 = 1.5 -> 2, 0.5 * 5 = 2.5 -> 2
  assert.deepEqual(s.knownMembers(15, 5, 0.5).perMarket, [ 2, 2, 2, 2, 2 ]);
  assert.deepEqual(s.knownMembers(25, 5, 0.5).perMarket, [ 2, 2, 2, 2, 2 ]);
  // at least one per market with markets
  assert.deepEqual(s.knownMembers(10, 5, 0.1).perMarket, [ 1, 1, 1, 1, 1 ]);
});

test('A2 keeps 10 known shops and review sites and scales the discoverable part', () => {
  const expected = {
    0.5: { shops: 15, pool: 7500, count: 200, products: 15000 },
    1: { shops: 20, pool: 10000, count: 400, products: 30000 },
    2: { shops: 30, pool: 15000, count: 800, products: 60000 },
    4: { shops: 50, pool: 25000, count: 1600, products: 120000 },
  };
  for (const [ scale, e ] of Object.entries(expected)) {
    const { yaml, overrides, inexact } = s.scaleOverrides(A2, BASE, Number(scale));
    assert.deepEqual(inexact, [], `x${scale}`);
    assert.equal(overrides['members.shops'], e.shops);
    assert.equal(overrides['members.review_sites'], e.shops);
    assert.equal(overrides['members.pool'], e.pool);
    assert.equal(overrides['brands.count'], e.count);
    assert.equal(overrides['brands.products'], e.products);
    const check = s.feasibility(s.generatorSettings(yaml));
    assert.deepEqual(check.problems, [], `x${scale}`);
    assert.equal(check.known.shops.known, 10, `x${scale}`);
    assert.equal(check.known.review_sites.known, 10, `x${scale}`);
    // Per pod the same: products per brand, and members (shops + review sites) per pool product
    assert.equal(e.products / e.count, 75);
    assert.equal(e.pool / (2 * e.shops), 250);
  }
  // x1 is the default point itself
  assert.equal(s.scaleOverrides(A2, BASE, 1).yaml, BASE);
});

test('A3 scales the data per pod and keeps the pods, the pool and the known members', () => {
  for (const scale of [ 0.5, 1, 2, 4 ]) {
    const { yaml, overrides, inexact } = s.scaleOverrides(A3, BASE, scale);
    assert.deepEqual(inexact, [], `x${scale}`);
    assert.deepEqual(overrides, {
      'members.offers': 1000 * scale,
      'members.reviews': 5000 * scale,
      'members.reviews_per_reviewer': 100 * scale,
      'brands.products': 30000 * scale,
      'brands.min_products': 20 * scale,
    });
    const settings = s.generatorSettings(yaml);
    // Fixed: the number of shops, review sites and brands, members.pool and known.ratio
    assert.equal(settings.shops, 20);
    assert.equal(settings.reviewSites, 20);
    assert.equal(settings.count, 400);
    assert.equal(settings.pool, 10000);
    assert.equal(settings.knownRatio, 0.5);
    const check = s.feasibility(settings);
    assert.deepEqual(check.problems, [], `x${scale}`);
    assert.equal(check.known.shops.known, 10, `x${scale}`);
    // The reviewers (reviews / reviews per reviewer) stay 50 per review site
    assert.equal(overrides['members.reviews'] / overrides['members.reviews_per_reviewer'], 50);
  }
  assert.equal(s.scaleOverrides(A3, BASE, 1).yaml, BASE);
});

test('feasibility catches what the generator would reject', () => {
  const settings = s.generatorSettings(BASE);
  assert.deepEqual(s.feasibility(settings).problems, []);
  assert.match(s.feasibility({ ...settings, products: 5000 }).problems.join(), /below members.pool|too small/u);
  assert.match(s.feasibility({ ...settings, pool: 29000 }).problems.join(), /products of its own brands/u);
  assert.match(s.feasibility({ ...settings, shops: 3 }).problems.join(), /leave markets without a member/u);
});

test('brandSizes matches catalog.brand_sizes', () => {
  // From the generator's own brand_sizes (Python) for the default point
  const sizes = s.brandSizes(30000, 400, 0.6, 20);
  assert.equal(sizes.length, 400);
  assert.equal(sizes.reduce((a, b) => a + b, 0), 30000);
  assert.equal(sizes[0], 1380);
  assert.equal(sizes.at(-1), 32);
});

test('combinations: jbr\'s order, and a selection by factor values', () => {
  const combinations = s.factorCombinations({ alg: [ 'a', 'b', 'c' ] }).map((factors, id) => ({ name: `combination_${id}`, id, factors }));
  assert.deepEqual(s.selectCombinations([ 'c', 'a' ], combinations, 'x').map(c => c.id), [ 0, 2 ]);
  assert.equal(s.selectCombinations(undefined, combinations, 'x'), combinations);
  assert.throws(() => s.selectCombinations([ 'z' ], combinations, 'x'), /no combination/u);
});

test('parseArgs: --include takes labels with or without x, comma-separated or repeated', () => {
  const { command, options } = s.parseArgs([ 'run', '--include', 'x4', '--include=8,16', '--ignore-gate' ]);
  assert.equal(command, 'run');
  assert.deepEqual([ ...options.include ], [ '4', '8', '16' ]);
  assert.ok(options.ignoreGate);
  assert.throws(() => s.parseArgs([ 'run', '--inclde', '4' ]), /Unknown option/u);
});

test('health counts errors, incomplete answers and timeouts; the gate reads it', () => {
  const dir = fs.mkdtempSync(Path.join(os.tmpdir(), 'vary-scale-'));
  try {
    const output = Path.join(dir, 'combination_1');
    fs.mkdirSync(output);
    fs.writeFileSync(Path.join(output, 'query-executions.csv'), [
      'name;id;complete;error;errorDescription;time',
      'q01;0;true;false;;1000',
      'q02;0;false;false;;2000',
      'q03;0;true;true;"boom; really";10',
      'q04;0;true;false;;179000',
      'q05;0;true;false;;3000',
    ].join('\n'));
    fs.writeFileSync(Path.join(output, 'stats-virtuoso-main.csv'),
      'cpu_percentage,memory,memory_percentage,received,transmitted\n1,100,30,0,0\n1,200,40.5,0,0\n');
    fs.writeFileSync(Path.join(output, 'stats-sparql-endpoint-comunica.csv'),
      'cpu_percentage,memory,memory_percentage,received,transmitted\n1,4294967296,20,0,0\n');
    const effective = { 'hookSparqlEndpoint.queryTimeout': 180, 'hookSparqlEndpoint.maxMemory': 8192 };
    const h = s.health(dir, [ { name: 'combination_1', factors: { alg: 'derived-pattern-only' } } ], effective);
    const c = h.combinations.combination_1;
    assert.equal(c.executions, 5);
    assert.equal(c.errors, 1);
    assert.equal(c.incomplete, 1);
    assert.equal(c.atTimeout, 1);
    assert.equal(c.failed, 3);
    assert.equal(c.failureShare, 0.6);
    assert.deepEqual(c.failedQueries, [ 'q02#0', 'q03#0', 'q04#0' ]);
    assert.equal(c.memoryPercentSum, 60.5);
    assert.equal(c.enginePeakOfHeap, 0.5);
    assert.equal(h.maxFailureShare, 0.6);
    const problems = s.gateProblems({ maxFailureShare: 0.1, maxMemoryPercent: 80 }, h);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /failed 3\/5/u);
    assert.deepEqual(s.gateProblems({ maxFailureShare: 0.7, maxMemoryPercent: 60 }, h).length, 1);
    assert.deepEqual(s.gateProblems({ maxFailureShare: 0.7, maxMemoryPercent: 80 }, h), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkGenerated wants the planned pods and exactly the known members', () => {
  const { yaml } = s.scaleOverrides(A2, BASE, 2);
  const measured = { kinds: { vendor: { pods: 30, known: 10 }, ratingsite: { pods: 30, known: 10 }, producer: { pods: 800 } } };
  assert.deepEqual(s.checkGenerated(A2, yaml, measured), []);
  measured.kinds.vendor.known = 12;
  measured.kinds.producer.pods = 799;
  assert.equal(s.checkGenerated(A2, yaml, measured).length, 2);
});

test('compareWithPoints warns when pods or the known federation change size', () => {
  const kinds = (perPod, known) => ({ vendor: { triplesPerPod: { mean: perPod }, knownTriples: known } });
  const runs = [ { name: 'output-1', summary: { measured: { kinds: kinds(1000, 10000) } } } ];
  assert.deepEqual(s.compareWithPoints({ kinds: kinds(1100, 10500) }, runs), []);
  assert.equal(s.compareWithPoints({ kinds: kinds(1500, 10000) }, runs).length, 1);
  assert.equal(s.compareWithPoints({ kinds: kinds(1000, 15000) }, runs).length, 1);
});

test('compareWithPoints, perPod scaled: the pods stay, their products, offers and reviews grow with the scale', () => {
  const kinds = (f, reviewers = 1000) => ({
    producer: { pods: 400, productsPerPod: { mean: 75 * f }, triplesPerPod: { mean: 1 } },
    vendor: { pods: 20, offersPerPod: { mean: 1000 * f }, triplesPerPod: { mean: 1 } },
    ratingsite: { pods: 20, reviewsPerPod: { mean: 5000 * f }, triplesPerPod: { mean: 1 } },
    reviewer: { pods: reviewers, triplesPerPod: { mean: 1 } },
  });
  const runs = [ { name: 'output-1', summary: { scale: 1, measured: { kinds: kinds(1) } } } ];
  assert.deepEqual(s.compareWithPoints({ kinds: kinds(2) }, runs, 'scaled', 2), []);
  assert.deepEqual(s.compareWithPoints({ kinds: kinds(0.5) }, runs, 'scaled', 0.5), []);
  // Did not grow as the scale says
  assert.equal(s.compareWithPoints({ kinds: kinds(1) }, runs, 'scaled', 2).length, 3);
  // A kind's number of pods changed
  assert.match(s.compareWithPoints({ kinds: kinds(2, 990) }, runs, 'scaled', 2).join(), /reviewer: 990 pods/u);
  // The same federation would warn under perPod same, as the known members grew
  const same = { kinds: { vendor: { triplesPerPod: { mean: 2000 }, knownTriples: 20000 } } };
  const sameRuns = [ { name: 'output-1', summary: { scale: 1, measured: { kinds: { vendor: { triplesPerPod: { mean: 1000 }, knownTriples: 10000 } } } } } ];
  assert.equal(s.compareWithPoints(same, sameRuns, 'same', 2).length, 2);
  assert.deepEqual(s.compareWithPoints(same, sameRuns, 'scaled', 2), []);
});

test('measure counts every pod\'s documents, without its .meta', () => {
  const dir = fs.mkdtempSync(Path.join(os.tmpdir(), 'vary-scale-'));
  try {
    const benchmark = Path.join(dir, 'benchmark');
    const write = (rel, text = '') => {
      fs.mkdirSync(Path.dirname(Path.join(benchmark, rel)), { recursive: true });
      fs.writeFileSync(Path.join(benchmark, rel), text);
    };
    write('publishers.json', JSON.stringify({
      vendor0: { kind: 'vendor', known: true, service: true, offers: 10, triples: 30 },
      vendor1: { kind: 'vendor', known: false, service: true, offers: 20, triples: 50 },
      producer0: { kind: 'producer', known: false, service: true, products: 5, triples: 40 },
    }));
    write('web/vendor0/.meta');
    write('web/vendor0/Product1');
    write('web/vendor0/Product2');
    write('web/vendor1/.meta');
    write('web/vendor1/Product1');
    write('web/producer0/products/2005-06');
    const m = s.measure(dir);
    assert.equal(m.documents, 4);
    assert.equal(m.storages, 3);
    assert.deepEqual(m.kinds.vendor.documentsPerPod, { mean: 1.5, median: 1.5, min: 1, max: 2 });
    assert.equal(m.kinds.vendor.offersPerPod.mean, 15);
    assert.equal(m.kinds.vendor.known, 1);
    assert.equal(m.kinds.producer.documentsPerPod.mean, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the default config is the one vary-*.json of the directory', () => {
  const dir = fs.mkdtempSync(Path.join(os.tmpdir(), 'vary-scale-'));
  try {
    assert.throws(() => s.defaultConfig(dir), /No vary-\*\.json/u);
    fs.writeFileSync(Path.join(dir, 'vary-pod-size.json'), '{}');
    fs.writeFileSync(Path.join(dir, 'package.json'), '{}');
    assert.equal(s.defaultConfig(dir), Path.join(dir, 'vary-pod-size.json'));
    fs.writeFileSync(Path.join(dir, 'vary-n-pods.json'), '{}');
    assert.throws(() => s.defaultConfig(dir), /Several configs/u);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('imageChanges reports an engine image that differs from a complete point\'s', () => {
  const runs = [ { name: 'output-1', summary: { engineImages: { 'engine:dev': 'sha256:a' } } } ];
  assert.deepEqual(s.imageChanges({ 'engine:dev': 'sha256:a' }, runs), []);
  assert.equal(s.imageChanges({ 'engine:dev': 'sha256:b' }, runs).length, 1);
  // Unknown IDs (no Docker) are not a difference
  assert.deepEqual(s.imageChanges({ 'engine:dev': undefined }, runs), []);
});
