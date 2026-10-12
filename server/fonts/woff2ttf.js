// WOFF (1.0) -> TTF átalakítás: a táblák zlib-bel tömörítve vannak, ezeket kicsomagoljuk és sfnt-vé rakjuk össze.
const fs = require('fs'); const zlib = require('zlib');
const [inp, out] = process.argv.slice(2);
const b = fs.readFileSync(inp);
if (b.toString('ascii', 0, 4) !== 'wOFF') throw new Error('nem WOFF');
const flavor = b.readUInt32BE(4), numTables = b.readUInt16BE(12);
const tables = [];
for (let i = 0; i < numTables; i++) {
  const o = 44 + i * 20;
  const tag = b.toString('ascii', o, o + 4), off = b.readUInt32BE(o + 4), comp = b.readUInt32BE(o + 8), orig = b.readUInt32BE(o + 12), sum = b.readUInt32BE(o + 16);
  let data = b.subarray(off, off + comp);
  if (comp < orig) data = zlib.inflateSync(data);
  tables.push({ tag, data, sum });
}
tables.sort((a, c) => (a.tag < c.tag ? -1 : 1));
let es = 0; while ((1 << (es + 1)) <= numTables) es++;
const sr = (1 << es) * 16;
const head = Buffer.alloc(12 + numTables * 16);
head.writeUInt32BE(flavor, 0); head.writeUInt16BE(numTables, 4); head.writeUInt16BE(sr, 6); head.writeUInt16BE(es, 8); head.writeUInt16BE(numTables * 16 - sr, 10);
let offset = head.length; const parts = [head];
tables.forEach((t, i) => {
  const o = 12 + i * 16;
  head.write(t.tag, o, 'ascii'); head.writeUInt32BE(t.sum, o + 4); head.writeUInt32BE(offset, o + 8); head.writeUInt32BE(t.data.length, o + 12);
  const pad = (4 - (t.data.length % 4)) % 4;
  parts.push(t.data, Buffer.alloc(pad)); offset += t.data.length + pad;
});
fs.writeFileSync(out, Buffer.concat(parts));
