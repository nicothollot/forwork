import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const buildDir = path.join(root, "build");
mkdirSync(buildDir, { recursive: true });

const iconSvgPath = path.join(buildDir, "hl-intelligence-app-icon.svg");
const smallIconSvgPath = path.join(buildDir, "hl-intelligence-app-icon-small.svg");
const tinyIconSvgPath = path.join(buildDir, "hl-intelligence-app-icon-tiny.svg");
const splashSvgPath = path.join(buildDir, "hl-intelligence-portable-splash.svg");
const iconPngPath = path.join(buildDir, "hl-intelligence-icon-1024.png");
const icoPath = path.join(buildDir, "hl-intelligence.ico");
const splashBmpPath = path.join(buildDir, "portable-splash.bmp");

writeFileSync(iconSvgPath, appIconSvg());
writeFileSync(smallIconSvgPath, smallAppIconSvg());
writeFileSync(tinyIconSvgPath, tinyAppIconSvg());
writeFileSync(splashSvgPath, portableSplashSvg());

run("convert", [
  "-background",
  "none",
  iconSvgPath,
  "-resize",
  "1024x1024",
  "-depth",
  "8",
  iconPngPath
]);

const iconSizes = [256, 128, 64, 48, 32, 16];
const pngInputs = iconSizes.map((size) => {
  const output = path.join(buildDir, `hl-intelligence-icon-${size}.png`);
  const sourceSvg = size <= 16 ? tinyIconSvgPath : size <= 32 ? smallIconSvgPath : iconSvgPath;
  run("convert", [
    "-background",
    "none",
    sourceSvg,
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

for (const pngInput of pngInputs) {
  if (pngInput === iconPngPath) continue;
}

console.log(`Generated Windows assets:
  ${path.relative(root, icoPath)}
  ${path.relative(root, iconPngPath)}
  ${path.relative(root, splashBmpPath)}`);

function appIconSvg() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" role="img" aria-label="HL Intelligence app icon">
  <defs>
    <linearGradient id="edge" x1="140" y1="116" x2="884" y2="900" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#508BC9"/>
      <stop offset="1" stop-color="#0067A5"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="176" fill="#002855"/>
  <path d="M132 266V172h760v680H132V266Z" fill="none" stroke="url(#edge)" stroke-width="28" opacity="0.95"/>
  <path d="M764 214h82v82M260 810h-82v-82" fill="none" stroke="#7E8597" stroke-width="18" stroke-linecap="square" opacity="0.52"/>
  <g opacity="0.18" stroke="#FFFFFF" stroke-width="5">
    <path d="M184 358h656M184 512h656M184 666h656"/>
    <path d="M338 204v616M512 204v616M686 204v616"/>
  </g>
  <text x="512" y="594"
    text-anchor="middle"
    font-family="Segoe UI, Arial, Helvetica, sans-serif"
    font-size="310"
    font-weight="700"
    letter-spacing="0"
    fill="#FFFFFF">HL</text>
  <g fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="M706 384L760 330H838" stroke="#508BC9" stroke-width="22"/>
    <path d="M708 512H832" stroke="#508BC9" stroke-width="22"/>
    <path d="M706 640L760 694H838" stroke="#508BC9" stroke-width="22"/>
  </g>
  <g fill="#FFFFFF" stroke="#508BC9" stroke-width="13">
    <circle cx="706" cy="384" r="19"/>
    <circle cx="838" cy="330" r="19"/>
    <circle cx="832" cy="512" r="19"/>
    <circle cx="706" cy="640" r="19"/>
    <circle cx="838" cy="694" r="19"/>
  </g>
</svg>`;
}

function smallAppIconSvg() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" role="img" aria-label="HL Intelligence compact app icon">
  <rect width="1024" height="1024" rx="176" fill="#002855"/>
  <rect x="118" y="118" width="788" height="788" rx="92" fill="none" stroke="#508BC9" stroke-width="56"/>
  <text x="510" y="626"
    text-anchor="middle"
    font-family="Segoe UI, Arial, Helvetica, sans-serif"
    font-size="380"
    font-weight="700"
    letter-spacing="0"
    fill="#FFFFFF">HL</text>
  <g fill="#508BC9">
    <circle cx="760" cy="338" r="42"/>
    <circle cx="804" cy="512" r="42"/>
    <circle cx="760" cy="686" r="42"/>
  </g>
</svg>`;
}

function tinyAppIconSvg() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" role="img" aria-label="HL Intelligence tiny app icon">
  <rect width="1024" height="1024" rx="128" fill="#002855"/>
  <text x="512" y="662"
    text-anchor="middle"
    font-family="Segoe UI, Arial, Helvetica, sans-serif"
    font-size="470"
    font-weight="800"
    letter-spacing="0"
    fill="#FFFFFF">HL</text>
</svg>`;
}

function portableSplashSvg() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="430" height="270" viewBox="0 0 430 270" role="img" aria-label="HL Intelligence loading">
  <rect width="430" height="270" fill="#F6F8FB"/>
  <rect x="0.5" y="0.5" width="429" height="269" fill="#FFFFFF" stroke="#D7DCE5"/>
  <g fill="none" stroke="#EDF2F7" stroke-width="1">
    ${gridLines()}
  </g>
  <rect x="22.5" y="22.5" width="385" height="225" fill="none" stroke="#BDD5EA" stroke-width="1"/>
  <rect x="36.5" y="36.5" width="357" height="197" fill="none" stroke="#CAD2DD" stroke-width="1"/>
  <g transform="translate(166 46) scale(0.096)">
    ${appIconSvg()
      .replace(/<\?xml[^>]*>\s*/, "")
      .replace(/<svg[^>]*>/, "")
      .replace("</svg>", "")}
  </g>
  <text x="215" y="176"
    text-anchor="middle"
    font-family="Segoe UI, Arial, Helvetica, sans-serif"
    font-size="19"
    font-weight="700"
    letter-spacing="0"
    fill="#002855">HL Intelligence</text>
  <text x="215" y="218"
    text-anchor="middle"
    font-family="Segoe UI, Arial, Helvetica, sans-serif"
    font-size="13"
    font-weight="500"
    letter-spacing="0"
    fill="#525766">Interface is loading</text>
  <rect x="104" y="235" width="222" height="3" fill="#E6EBF2"/>
  <rect x="104" y="235" width="96" height="3" fill="#0067A5"/>
</svg>`;
}

function gridLines() {
  const lines = [];
  for (let x = 34; x < 430; x += 34) lines.push(`<path d="M${x} 0V270"/>`);
  for (let y = 34; y < 270; y += 34) lines.push(`<path d="M0 ${y}H430"/>`);
  return lines.join("\n    ");
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
