// Isolated synthetic fixtures; never scans, renames or edits user textbooks.
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert/strict');
const { spawn } = require('child_process');
const { once } = require('events');
const { performance } = require('perf_hooks');
const delay = ms => new Promise(r => setTimeout(r, ms));
async function hashProbe(mode, file) {
  const child = spawn(process.execPath, ['-e', `
    const fs=require('fs'),crypto=require('crypto');
    const {inspectPdf}=require(${JSON.stringify(require.resolve('../core/pdfFiles'))});
    const start=performance.now();let maxDelay=0,last=start;
    const timer=setInterval(()=>{const now=performance.now();maxDelay=Math.max(maxDelay,now-last-5);last=now;},5);
    (async()=>{
      let hash;
      if(${JSON.stringify(mode)}==='old-sync'){
        const first=fs.readFileSync(${JSON.stringify(file)});
        crypto.createHash('md5').update(first).digest('hex');
        const second=fs.readFileSync(${JSON.stringify(file)});
        hash=crypto.createHash('sha256').update(second).digest('hex');
      }else hash=(await inspectPdf(${JSON.stringify(file)})).sha256;
      const elapsed=performance.now()-start;
      await new Promise(r=>setTimeout(r,15));clearInterval(timer);
      console.log(JSON.stringify({mode:${JSON.stringify(mode)},elapsed_ms:elapsed,max_event_loop_delay_ms:maxDelay,peak_rss_mib:process.resourceUsage().maxRSS/1024,sha256:hash}));
    })().catch(e=>{console.error(e);process.exitCode=1});
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = ''; child.stdout.on('data', data => out += data);
  const [code] = await once(child, 'exit'); assert.equal(code, 0);
  return JSON.parse(out.trim());
}
async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'k12-bulk-performance-'));
  const state = path.join(root, 'state'), dir = path.join(root, 'books');
  await fsp.mkdir(state); await fsp.mkdir(dir);
  const large = path.join(root, 'large.pdf');
  const handle = await fsp.open(large, 'w');
  const chunk = Buffer.alloc(1024 * 1024, 32); chunk.write('%PDF-1.7\n');
  await handle.write(chunk); chunk.fill(32);
  for (let i = 1; i < 128; i++) await handle.write(chunk);
  await handle.write(Buffer.from('\n%%EOF\n'), 0, 7, 128 * 1024 * 1024 - 7);
  await handle.close();
  const old = await hashProbe('old-sync', large), streamed = await hashProbe('stream', large);
  assert.equal(old.sha256, streamed.sha256);
  const { inspectPdf } = require('../core/pdfFiles');
  const largeInfo = await inspectPdf(large);
  const small = Buffer.from('%PDF-1.7\n' + 'fixture\n'.repeat(500) + '%%EOF\n');
  const smallHash = crypto.createHash('sha256').update(small).digest('hex');
  const books = [];
  for (let i = 0; i < 3000; i++) {
    const name = `book-${String(i).padStart(4, '0')}.pdf`, file = path.join(dir, name);
    if (i === 0) await fsp.copyFile(large, file); else await fsp.writeFile(file, small);
    const size = i === 0 ? largeInfo.size : small.length;
    const book = { id: 'book-' + i, title: name, clean_title: name, filename: name, relative_path: name,
      update_time: 'v1', pdf_size: size, is_active: true, has_pdf: true };
    books.push(book);
    await fsp.writeFile(file + '.download.json', JSON.stringify({ id: book.id, update_time: 'v1', size,
      sha256: i === 0 ? largeInfo.sha256 : smallHash }));
    await fsp.writeFile(path.join(dir, name + '.backup.pdf'), small);
  }
  await fsp.writeFile(path.join(dir, '个人笔记.pdf'), small);
  await fsp.mkdir(path.join(dir, 'History')); await fsp.writeFile(path.join(dir, 'History', 'old.pdf'), small);
  await fsp.writeFile(path.join(state, 'config.json'), JSON.stringify({ download_dir: dir }));
  await fsp.writeFile(path.join(state, 'catalog.json'), JSON.stringify({ books, stats: { total: 3000, downloadable_pdf: 3000 } }));
  const child = spawn(process.execPath, ['-e', `const app=require(${JSON.stringify(require.resolve('../server'))});app.runServer(0,()=>process.send(app.server.address().port));`], {
    env: { ...process.env, CHINAK12_DATA_DIR: state }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const [port] = await once(child, 'message'); const base = `http://127.0.0.1:${port}`;
  const results = { fixture_root: root, current_textbooks: 3000, backup_copies: 3000, unrelated_pdfs: 1, large_file_mib: 128, old_sync: old, streaming: streamed };
  async function measure(name, operation) {
    let done = false, maximum = 0, probes = 0;
    const ping = (async () => { while (!done) {
      const start = performance.now(); const res = await fetch(base + '/api/config'); await res.json();
      maximum = Math.max(maximum, performance.now() - start); probes++; await delay(5);
    } })();
    const start = performance.now(); let result;
    try { result = await operation(); } finally { done = true; await ping; }
    results[name] = { elapsed_ms: performance.now() - start, max_config_response_ms: maximum, responsiveness_probes: probes };
    return result;
  }
  try {
    const inventory = () => fetch(base + '/api/inventory').then(r => r.json());
    assert.equal((await measure('inventory_cold', inventory)).downloaded_pdf, 3000);
    assert.equal((await measure('inventory_warm', inventory)).downloaded_pdf, 3000);
    const concurrent = await measure('inventory_5_concurrent', () => Promise.all(Array.from({ length: 5 }, inventory)));
    assert.ok(concurrent.every(r => r.downloaded_pdf === 3000));
    const post = (route, body = {}) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
    const archive = await measure('reconcile_6001_pdfs', () => post('/api/reconcile_and_archive'));
    assert.equal(archive.active_kept, 3000); assert.equal(archive.total_archived, 0);
    const batch = await measure('enqueue_3000_existing', () => post('/api/download', { book_ids: books.map(b => b.id) }));
    assert.equal(batch.success, true); assert.equal(batch.added_count, 0);
    assert.equal((await inventory()).downloaded_pdf, 3000);
    assert.equal((await inspectPdf(path.join(dir, 'book-0000.pdf'))).sha256, largeInfo.sha256);
    await fsp.writeFile(path.join(root, 'results.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results, null, 2));
  } finally { child.kill('SIGTERM'); await once(child, 'exit'); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
