// Mac: Apple 인증서 없이 임시(ad-hoc) 서명. 서명이 아예 없으면 Apple 실리콘 맥에서 "손상된 앱"으로 뜬다.
// dmg 를 만들기 전(afterPack)에 앱 묶음 전체를 서명한다.
const { execFileSync } = require('child_process');

exports.default = async (ctx) => {
  if (ctx.electronPlatformName !== 'darwin') return;
  const app = `${ctx.appOutDir}/${ctx.packager.appInfo.productFilename}.app`;
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
};
