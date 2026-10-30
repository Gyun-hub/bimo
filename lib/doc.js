// 문서 카드(PDF·이미지)용 확장자 판정·bimo-doc 주소. electron 의존 없음(단위 테스트용).

// 카드로 보여 줄 수 있는 확장자 → Content-Type
const DOC_TYPES = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
// OS 앱으로 열어도 되는 확장자(허용 목록). 목록에 없는 것은 전부 거절한다 — 매크로 Office(docm·xlsm…)·chm·rdp 처럼
// 열면 코드가 도는 형식이 계속 늘어나 거절 목록으로는 다 막을 수 없다.
const OPENABLE = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'hwp', 'hwpx', 'pdf',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'psd',
  'mp3', 'wav', 'm4a', 'flac', 'mp4', 'mov', 'avi', 'mkv', 'webm', 'zip', '7z', 'rar',
  // 텍스트(1MB 넘어 편집기 탭에 못 여는 것). 편집기로 열려 실행되지 않는다. svg·html 은 브라우저에서 스크립트가 돌아 뺀다.
  'txt', 'csv', 'tsv', 'log', 'json', 'md', 'xml', 'yaml', 'yml']);

// 마지막 확장자(소문자). Windows 는 끝의 점·공백을 버리고 'a.exe::$DATA' 같은 스트림 이름도 실행되므로 그만큼 떼고 본다.
const ext = (p) => (String(p).split(/[\\/]/).pop().replace(/[. ]+$/, '').match(/\.([^.]*)$/)?.[1] || '').split(':')[0].toLowerCase();
const docType = (p) => DOC_TYPES[ext(p)] || null;
// 이름에 ':' 가 있으면 NTFS 스트림('a.exe:x.docx')이라 확장자만 보고 믿지 않는다.
const openable = (p) => !String(p).split(/[\\/]/).pop().includes(':') && OPENABLE.has(ext(p));

// bimo-doc://<id>/<이름>. 이름은 보기용(PDF 뷰어 제목·저장 이름)이고 찾는 데는 id 만 쓴다.
const ID_RE = /^[0-9a-f]{32}$/;
const docUrl = (id, p) => `bimo-doc://${id}/${encodeURIComponent(String(p).split(/[\\/]/).pop())}`;
const docId = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === 'bimo-doc:' && ID_RE.test(u.hostname) ? u.hostname : null;
  } catch {
    return null;
  }
};

module.exports = { DOC_TYPES, ext, docType, openable, docUrl, docId };
