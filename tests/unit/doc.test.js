const test = require('node:test');
const assert = require('node:assert');
const { ext, docType, openable, docUrl, docId } = require('../../lib/doc');

test('docType: PDF·이미지만, 대소문자 무시', () => {
  assert.strictEqual(docType('C:\\Users\\a b\\기획서_1.0.10v_3.PDF'), 'application/pdf');
  assert.strictEqual(docType('/Users/a/x.JpEg'), 'image/jpeg');
  assert.strictEqual(docType('a.webp'), 'image/webp');
  for (const p of ['a.txt', 'a.exe', 'a.pdf.exe', 'pdf', 'a', '', 'C:\\x.pdf\\a.svg']) assert.strictEqual(docType(p), null, p);
});

test('ext: 폴더 이름의 점·끝 점·공백·스트림 이름에 속지 않는다', () => {
  assert.strictEqual(ext('C:\\a.pdf\\readme'), '');
  assert.strictEqual(ext('a.exe.'), 'exe');
  assert.strictEqual(ext('a.exe . '), 'exe');
  assert.strictEqual(ext('a.exe::$DATA'), 'exe');
  assert.strictEqual(ext('.bashrc'), 'bashrc');
});

test('openable: 허용 목록의 문서·미디어·압축만, 나머지는 거절', () => {
  for (const p of ['a.pdf', 'C:\\x\\a.DOCX', 'a.xls', 'a.xlsx', 'a.pptx', 'a.odt', 'a.rtf', 'a.hwp', 'a.hwpx', 'a.png', 'a.heic', 'a.psd',
    'a.mp3', 'a.mkv', 'a.webm', 'a.zip', 'a.7z', 'a.rar', '/Users/a/b c/기획서.pdf',
    'a.txt', 'a.csv', 'a.json', 'C:\\logs\\app.LOG'])
    assert.ok(openable(p), p);
  for (const p of ['a.chm', 'a.library-ms', 'a.xlsm', 'a.docm', 'a.pptm', 'a.rdp', 'a.fileloc', 'a.xll', 'Makefile', '/usr/bin/tool', '',
    'a.docx.exe', 'a.exe::$DATA', 'a.exe:x.docx', 'C:\\x\\setup.EXE', 'a.bat', 'a.ps1', 'a.lnk', 'a.js', 'C:\\a.pdf\\readme', 'a.svg', 'a.html', 'a.htm', undefined])
    assert.ok(!openable(p), String(p));
});

test('docUrl/docId: 왕복, 이름은 인코딩', () => {
  const id = 'a'.repeat(32);
  const url = docUrl(id, 'C:\\Users\\admin\\Desktop\\에이핀 세부기획서 #1?.pdf');
  assert.strictEqual(url, `bimo-doc://${id}/${encodeURIComponent('에이핀 세부기획서 #1?.pdf')}`);
  assert.strictEqual(docId(url), id);
  assert.strictEqual(docId(docUrl(id, '/Users/a/x.png')), id);
});

test('docId: 엉터리 주소는 null', () => {
  for (const u of ['bimo-doc://zz/x.pdf', `bimo-doc://${'A'.repeat(31)}/x`, `file://${'a'.repeat(32)}/x`, 'not a url', '', undefined])
    assert.strictEqual(docId(u), null, String(u));
});
