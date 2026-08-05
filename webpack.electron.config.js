// webpack.electron.config.js — Electron 메인 프로세스(main.js) + preload.js를
// electron-dist/ 로 번들링한다. 산출물이 electron/main.js(전자, dev 폴백에서
// project root 기준 상대경로 사용)와 동일한 깊이(project root 바로 아래)에
// 있어야 electron/server.js 의 `path.join(__dirname, "..", "out")` 같은 dev
// 폴백 경로가 그대로 맞는다 — electron/ipc/audio-device.js 의 헬퍼 바이너리
// 경로는 원래 electron/ipc/(한 단계 더 깊음) 기준이었어서 번들링 시 깊이가
// 바뀌는 만큼 그 파일 쪽에서 상대경로를 한 단계 줄여 맞춰뒀다(주석 참고).
const path = require("path");

const common = {
  mode: "production",
  resolve: { extensions: [".js"] },
  output: {
    path: path.resolve(__dirname, "electron-dist"),
  },
};

module.exports = [
  {
    ...common,
    target: "electron-main",
    entry: "./electron/main.js",
    output: { ...common.output, filename: "main.js" },
  },
  {
    ...common,
    target: "electron-preload",
    entry: "./electron/preload.js",
    output: { ...common.output, filename: "preload.js" },
  },
];
