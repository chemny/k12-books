const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { cascade } = require('../web/filters');
const { compareCatalogs, validateCatalog } = require('../core/catalogSync');
const { normalizeRawBook, resolvePdfRenditions } = require('../core/catalog');
const books = JSON.parse(fs.readFileSync(require.resolve('../data/catalog_cache.json'))).books;
test('PPTX source with official PDF rendition stays downloadable with PDF size', async () => {
  const raw = { id: 'lesson', update_time: 'v1', custom_properties: { format: 'pptx', size: 54000000 } };
  let calls = 0;
  const fetch = async () => {
    calls++;
    return { ti_items: [
      { ti_format: 'pptx', ti_file_flag: 'source', ti_size: 54000000, ti_storages: ['https://example/source'] },
      { ti_format: 'pdf', ti_file_flag: 'pdf', ti_size: 3700000, ti_storages: ['https://example/official.pdf'] },
    ] };
  };
  const cache = await resolvePdfRenditions([raw], fetch);
  const book = normalizeRawBook(raw, 1);
  assert.equal(book.has_pdf, true);
  assert.equal(book.has_pptx, true);
  assert.equal(book.pdf_size, 3700000);
  assert.equal(book.pptx_size, 54000000);
  const fresh = { ...raw, ti_items: [] };
  await resolvePdfRenditions([fresh], fetch, cache);
  assert.equal(calls, 1);
  await resolvePdfRenditions([{ ...fresh, update_time: 'v2', ti_items: [] }], fetch, cache);
  assert.equal(calls, 2);
});
test('source size alone cannot imply PDF; failed detail lookup aborts catalog resolution', async () => {
  const raw = { id: 'lesson', custom_properties: { format: 'pptx', size: 999 } };
  assert.equal(normalizeRawBook(raw, 1).has_pdf, false);
  assert.equal(normalizeRawBook({ id: 'unknown' }, 1).has_pdf, false);
  await assert.rejects(resolvePdfRenditions([raw], async () => { throw new Error('offline'); }), /offline/);
  await assert.rejects(resolvePdfRenditions([raw], async () => ({})), /文件详情不完整/);
  await resolvePdfRenditions([raw], async () => ({ ti_items: [{ ti_format: 'pptx', ti_storages: ['source'] }] }));
  assert.equal(normalizeRawBook(raw, 1).has_pdf, false);
});
test('course containers remain in the full catalog and child PDFs resolve through official parent lists', async () => {
  const parent = { id: 'parent', resource_type_code: 'thematic_course', ti_items: [] };
  const child = { id: 'child', update_time: 'v1', resource_custom_properties: { compound_node: 'sub' },
    teachmeterial_ids: ['parent'], custom_properties: { format: 'pptx', size: 900 } };
  await resolvePdfRenditions([parent, child], async url => {
    assert.match(url, /thematic_course\/parent\/resources\/list\.json$/);
    return [{ id: 'child', ti_items: [{ ti_format: 'pdf', ti_size: 300, ti_storages: ['https://example/pdf'] }] }];
  });
  assert.equal(normalizeRawBook(parent, 1).kind, 'course');
  assert.equal(normalizeRawBook(parent, 1).has_pdf, false);
  assert.equal(normalizeRawBook(child, 2).pdf_size, 300);
  assert.deepEqual(normalizeRawBook(child, 2).parent_ids, ['parent']);
  const resolved = [parent, child].map((raw, i) => ({ ...normalizeRawBook(raw, i), is_active: true }));
  assert.equal(resolved.filter(book => book.has_pdf).length, 1);
  assert.equal(resolved.length, 2);
});
test('all-directory filters retain course-only and historical categories', () => {
  const sample = [
    { is_active: true, has_pdf: true, stage: '小学', grade: '一年级' },
    { is_active: true, has_pdf: false, stage: '初中', grade: '七年级' },
    { is_active: false, has_pdf: true, stage: '高中', grade: '高一年级' },
  ];
  assert.deepEqual(cascade(sample).options.stage, ['小学']);
  assert.deepEqual(cascade(sample, {}, null, true).options.stage, ['小学', '初中', '高中']);
});
test('sixth grade Chinese automatically selects unified edition; mathematics offers actual versions', () => {
  const chinese = cascade(books, { stage: '小学', grade: '六年级', subject: '语文' });
  assert.deepEqual(chinese.options.version, ['统编版']);
  assert.equal(chinese.values.version, '统编版');
  assert.deepEqual(chinese.options.volume, ['上册', '下册']);
  const math = cascade(books, { stage: '小学', grade: '六年级', subject: '数学' });
  assert.ok(math.options.version.includes('人教版'));
  assert.ok(!math.options.version.includes('人教A版'));
});
test('changing an upstream filter clears incompatible downstream choices', () => {
  const result = cascade(books, { stage: '高中', grade: '六年级', subject: '数学', version: '人教版' }, 'stage');
  assert.equal(result.values.grade, '');
  assert.equal(result.values.subject, '');
  assert.equal(result.values.version, '');
  assert.ok(!result.options.grade.includes('六年级'));
});
test('grade order follows school order instead of string order', () => {
  const result = cascade(books, { stage: '小学' });
  const grades = result.options.grade.filter(g => ['一年级','二年级','三年级','四年级','五年级','六年级'].includes(g));
  assert.deepEqual(grades, ['一年级','二年级','三年级','四年级','五年级','六年级']);
});
test('sync distinguishes additions, changed records and missing IDs', () => {
  const before = { books: [{ id: 'a', title: 'old' }, { id: 'b', title: 'missing' }] };
  const after = { books: [{ id: 'a', title: 'new' }, { id: 'c', title: 'added' }] };
  const changes = compareCatalogs(before, after);
  assert.deepEqual([changes.added, changes.changed, changes.missing], [1,1,1]);
  assert.deepEqual(changes.missing_ids, ['b']);
});
test('empty, malformed and suspiciously incomplete catalogs cannot replace a snapshot', () => {
  assert.throws(() => validateCatalog([]));
  assert.throws(() => validateCatalog([{ id: 'a' }]));
  assert.throws(() => validateCatalog([{ id: 'a', title: 'x' }, { id: 'a', title: 'y' }]));
  assert.throws(() => validateCatalog([{ id: 'a', title: 'x' }], 100));
  assert.doesNotThrow(() => validateCatalog(books, books.length));
});

test('civics subjects follow every other subject including unlabelled subjects', () => {
  const sample = ['思想政治', '未标注', '道德与法治', '语文', '新学科'].map(subject => ({ subject, is_active: true, has_pdf: true }));
  assert.deepEqual(cascade(sample).options.subject.slice(-2), ['道德与法治', '思想政治']);
});
test('edition choices follow the selected textbooks and clear after an upstream change', () => {
  const sample = [
    { subject: '语文', edition_tag: '2012修订版' },
    { subject: '语文', edition_tag: '2022修订版' },
    { subject: '语文', edition_tag: '版本待确认' },
    { subject: '数学', edition_tag: '2022版' },
  ].map(book => ({ ...book, is_active: true, has_pdf: true }));
  const result = cascade(sample, { subject: '语文', edition_tag: '2012修订版' });
  assert.deepEqual(result.options.edition_tag, ['2012修订版', '2022修订版', '版本待确认']);
  assert.equal(result.values.edition_tag, '2012修订版');
  const changed = cascade(sample, { subject: '数学', edition_tag: '2012修订版' }, 'subject');
  assert.deepEqual(changed.options.edition_tag, ['2022版']);
  assert.equal(changed.values.edition_tag, '');
});

test('edition tags use explicit title evidence and never infer edition from upload time', () => {
  const { extractEditionTag } = require('../core/catalog');
  assert.equal(extractEditionTag('语文（2012修订版）'), '2012修订版');
  assert.equal(extractEditionTag('数学（2022年修订）'), '2022修订版');
  assert.equal(extractEditionTag('根据2022年版课程标准修订'), '2022修订版');
  assert.equal(extractEditionTag('语文九年级下册', { update_time: '2026-03-02' }), '版本待确认');
});
test('catalog classification and edition changes count as changes even with the same upload time', () => {
  const before = { books: [{ id: 'a', title: '语文', subject: '未标注', edition_tag: '版本待确认' }] };
  const next = { books: [{ ...before.books[0], subject: '语文', edition_tag: '2022修订版' }] };
  assert.deepEqual(compareCatalogs(before, next).changed_ids, ['a']);
});
