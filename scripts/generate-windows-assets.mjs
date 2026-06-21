import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const buildDir = path.join(root, "build");
const horizontalLogoPath = path.join(root, "Houlihan-Lokey-Logo+mark-1-line-horizontal_rgb.svg");

mkdirSync(buildDir, { recursive: true });

const iconSourceSvgPath = path.join(buildDir, "hl-intelligence-icon-source.svg");
const splashSvgPath = path.join(buildDir, "hl-intelligence-portable-splash.svg");
const officialLogoPngPath = path.join(buildDir, "hl-official-logo-horizontal-2048.png");
const officialMarkPngPath = path.join(buildDir, "hl-official-mark.png");
const iconPngPath = path.join(buildDir, "hl-intelligence-icon-1024.png");
const icoPath = path.join(buildDir, "hl-intelligence.ico");
const splashBmpPath = path.join(buildDir, "portable-splash.bmp");

const horizontalLogo = readOfficialSvg(horizontalLogoPath);

run("convert", [
  "-background",
  "none",
  horizontalLogoPath,
  "-resize",
  "2048x",
  officialLogoPngPath
]);
run("convert", [
  officialLogoPngPath,
  "-crop",
  "470x535+0+0",
  "+repage",
  officialMarkPngPath
]);

writeFileSync(iconSourceSvgPath, appIconSvg(readFileSync(officialMarkPngPath).toString("base64")), "utf8");
writeFileSync(splashSvgPath, portableSplashSvg(horizontalLogo), "utf8");

run("convert", [
  "-background",
  "none",
  iconSourceSvgPath,
  "-resize",
  "1024x1024",
  "-depth",
  "8",
  iconPngPath
]);

const iconSizes = [256, 128, 64, 48, 40, 32, 24, 20, 16];
const pngInputs = iconSizes.map((size) => {
  const output = path.join(buildDir, `hl-intelligence-icon-${size}.png`);
  run("convert", [
    "-background",
    "none",
    iconSourceSvgPath,
    "-resize",
    `${size}x${size}`,
    "-depth",
    "8",
    output
  ]);
  return output;
});

run("convert", [...pngInputs, icoPath]);
copyFileSync(icoPath, path.join(buildDir, "icon.ico"));
copyFileSync(icoPath, path.join(buildDir, "installerIcon.ico"));
copyFileSync(icoPath, path.join(buildDir, "installerHeaderIcon.ico"));
copyFileSync(icoPath, path.join(buildDir, "uninstallerIcon.ico"));

run("convert", [
  "-background",
  "white",
  splashSvgPath,
  "-resize",
  "430x270!",
  "-alpha",
  "remove",
  "-alpha",
  "off",
  `BMP3:${splashBmpPath}`
]);

console.log(`Generated Windows assets:
  ${path.relative(root, icoPath)}
  ${path.relative(root, iconPngPath)}
  ${path.relative(root, splashBmpPath)}`);

function readOfficialSvg(svgPath) {
  const svg = readFileSync(svgPath, "utf8");
  const body = svg
    .replace(/<\?xml[^>]*>\s*/i, "")
    .replace(/<!--[\s\S]*?-->\s*/g, "")
    .replace(/<svg[^>]*>/i, "")
    .replace(/<\/svg>\s*$/i, "");
  return body.trim();
}

function appIconSvg(officialMarkBase64) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" role="img" aria-label="HL Intelligence app icon">
  <rect width="1024" height="1024" rx="144" fill="#FFFFFF"/>
  <rect x="50" y="50" width="924" height="924" rx="116" fill="#FFFFFF" stroke="#D7DCE5" stroke-width="10"/>
  <rect x="88" y="88" width="848" height="848" rx="86" fill="none" stroke="#EEF2F6" stroke-width="6"/>
  <image x="167" y="121" width="690" height="783" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,${officialMarkBase64}"/>
</svg>`;
}

function portableSplashSvg(officialLogoBody) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="430" height="270" viewBox="0 0 430 270" role="img" aria-label="HL Intelligence loading">
  <rect width="430" height="270" fill="#F6F8FB"/>
  <rect x="0.5" y="0.5" width="429" height="269" fill="#FFFFFF" stroke="#D7DCE5"/>
  <rect x="22.5" y="22.5" width="385" height="225" fill="none" stroke="#E3E8EF"/>
  <rect x="36.5" y="36.5" width="357" height="197" fill="none" stroke="#F1F4F8"/>
  <g transform="translate(118 42) scale(0.52)">
    ${officialLogoBody}
  </g>
  <text x="215" y="143"
    text-anchor="middle"
    font-family="Arial, Helvetica, sans-serif"
    font-size="19"
    font-weight="700"
    letter-spacing="0"
    fill="#002855">HL Intelligence</text>
  <text x="215" y="171"
    text-anchor="middle"
    font-family="Arial, Helvetica, sans-serif"
    font-size="13"
    font-weight="500"
    letter-spacing="0"
    fill="#525766">Secure document preparation</text>
  <rect x="104" y="232" width="222" height="3" fill="#E6EBF2"/>
  <rect x="104" y="232" width="96" height="3" fill="#0067A5"/>
</svg>`;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit"
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
