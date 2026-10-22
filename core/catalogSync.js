// Compare platform records by stable resource ID, not guessed textbook editions.
function compareCatalogs(previous, next) {
  const before = new Map((previous.books || []).map(b => [b.id, b]));
  const after = new Map(next.books.map(b => [b.id, b]));
  const fields = ['title', 'update_time', 'pdf_size', 'has_pdf', 'has_pptx', 'pptx_size',
    'stage', 'grade', 'subject', 'version', 'publisher_dir', 'volume', 'edition_tag', 'relative_path', 'is_active'];
  const added = [], changed = [], missing = [];
  for (const [id, book] of after) {
    if (!before.has(id)) added.push(id);
    else if (fields.some(f => before.get(id)[f] !== book[f])) changed.push(id);
  }
  for (const id of before.keys()) if (!after.has(id)) missing.push(id);
  return { added: added.length, changed: changed.length, missing: missing.length,
    added_ids: added, changed_ids: changed, missing_ids: missing };
}

function validateCatalog(books, previousCount = 0) {
  if (!books.length) throw new Error('平台目录为空，已保留原目录');
  const ids = new Set();
  for (const book of books) {
    if (!book.id || !book.title || ids.has(book.id)) throw new Error('平台目录缺少教材信息或包含重复 ID，已保留原目录');
    ids.add(book.id);
  }
  if (previousCount && books.length < previousCount * 0.8) {
    throw new Error('平台目录数量异常减少超过 20%，暂不替换原目录，请稍后重试并核查平台变化');
  }
}
module.exports = { compareCatalogs, validateCatalog };
