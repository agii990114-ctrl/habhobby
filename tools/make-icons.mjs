/* 앱 아이콘 PNG를 굽는다.  실행:  node tools/make-icons.mjs

   **왜 스크립트인가.** 매니페스트에 SVG 하나만 두면 브라우저에서는 잘 보이지만
   안드로이드 설치 프롬프트와 Play 스토어(TWA)는 래스터 PNG를 요구한다. 그렇다고
   손으로 내보낸 PNG를 저장소에 넣어 두면, 아이콘을 고칠 때 SVG만 고치고 PNG는
   옛 그림으로 남는다 — 어느 쪽이 진짜인지 알 수 없어진다. 굽는 법을 적어 둔다.

   **왜 라이브러리가 없는가.** 이 저장소는 dependencies 가 하나도 없다(package.json).
   아이콘 하나 만들자고 그 규칙을 깨지 않는다. 그릴 것이 둥근 사각 다섯뿐이라
   직접 칠하고, 압축은 node 에 이미 들어 있는 zlib 이 한다.

   **그림은 icon.svg 와 같아야 한다.** 아래 SHAPES 가 그 사본이다 — 한쪽을 고치면
   다른 쪽도 고쳐야 한다. 눈으로 견주기 쉽도록 좌표를 SVG 와 같은 차례로 적어 둔다. */

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

// icon.svg 의 rect 들. viewBox 0 0 512 512 안의 좌표 그대로다.
const BG = { x: 0, y: 0, w: 512, h: 512, r: 112, fill: [0xC9, 0x4F, 0x0D], a: 1 };
const SHAPES = [
  { x: 120, y: 128, w: 72, h: 256, r: 14, fill: [255, 255, 255], a: 0.55 },
  { x: 220, y: 100, w: 72, h: 284, r: 14, fill: [255, 255, 255], a: 0.8 },
  { x: 320, y: 150, w: 72, h: 234, r: 14, fill: [255, 255, 255], a: 1 },
  { x: 104, y: 400, w: 304, h: 26, r: 13, fill: [255, 255, 255], a: 0.9 },
];

/* 마스커블은 **운영체제가 제 모양으로 잘라 낸다** — 원·둥근 사각·물방울, 기기마다 다르다.
   그래서 둘이 다르다:
     · 바탕은 모서리를 깎지 않고 512×512 를 꽉 채운다. 미리 깎아 두면 잘린 자리에
       배경이 없어 흰 귀퉁이가 남는다.
     · 그림은 **안전 영역**(가운데 지름 80% 원) 안으로 줄인다. 원래 그림은 304×326 이라
       대각선이 445 로 그 원(409.6)을 넘는다. 0.82 로 줄이면 365 가 되어 들어온다.
   그림 한가운데(256,263)를 아이콘 한가운데(256,256)에 맞춘 뒤 그 점을 축으로 줄인다. */
const MASK_SCALE = 0.82, ART_CX = 256, ART_CY = 263;

/* **바탕을 깎는지와 그림을 줄이는지는 따로 정해진다.** 한 낱말(maskable)로 둘을 묶어
   두었더니 iOS 용을 만들 자리가 없었다 — iOS 는 마스커블처럼 제 모양으로 깎지만
   덧대는 여백은 없다. 안전 영역까지 줄이면 아이콘 속 그림만 혼자 작아 보인다.
     round … 웹 아이콘. 바탕 모서리를 깎아 두고 그림은 그대로.
     mask  … 마스커블. 바탕은 꽉 채우고(OS 가 깎는다) 그림은 안전 영역으로 줄인다.
     apple … iOS 홈 화면. 바탕은 꽉 채우고(iOS 가 깎는다) 그림은 그대로. */
const KINDS = {
  round: { bleed: false, shrink: false },
  mask: { bleed: true, shrink: true },
  apple: { bleed: true, shrink: false },
};

/** 둥근 사각의 부호거리. 음수면 안쪽, 0 이 테두리 — 이 값으로 가장자리를 부드럽게 한다. */
function sdRoundRect(px, py, s) {
  const hx = s.w / 2, hy = s.h / 2;
  const qx = Math.abs(px - (s.x + hx)) - (hx - s.r);
  const qy = Math.abs(py - (s.y + hy)) - (hy - s.r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - s.r;
}

/** size×size RGBA 픽셀을 만든다. @param kind KINDS 의 갈래 이름 */
function render(size, kind) {
  const { bleed, shrink } = KINDS[kind];
  const SS = 4;                       // 한 픽셀을 4×4 로 잘게 재서 계단을 없앤다
  const px = new Uint8ClampedArray(size * size * 4);
  const bg = bleed ? { ...BG, r: 0 } : BG;
  const k = 512 / size;               // 화면 좌표 → 그림 좌표

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;   // 미리 곱해 두지 않은 채로 겹쳐 칠한다
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const dx = (x + (sx + 0.5) / SS) * k;
          const dy = (y + (sy + 0.5) / SS) * k;
          let cr = 0, cg = 0, cb = 0, ca = 0;
          const put = (s, hit) => {
            if (!hit) return;
            const al = s.a;
            cr = s.fill[0] * al + cr * (1 - al);
            cg = s.fill[1] * al + cg * (1 - al);
            cb = s.fill[2] * al + cb * (1 - al);
            ca = al + ca * (1 - al);
          };
          put(bg, sdRoundRect(dx, dy, bg) <= 0);
          // 줄일 때도 바탕은 그대로 꽉 찬다 — 그림만 줄인 만큼 되돌려 재면 된다.
          const ax = shrink ? (dx - 256) / MASK_SCALE + ART_CX : dx;
          const ay = shrink ? (dy - 256) / MASK_SCALE + ART_CY : dy;
          for (const s of SHAPES) put(s, sdRoundRect(ax, ay, s) <= 0);
          r += cr; g += cg; b += cb; a += ca;
        }
      }
      const n = SS * SS, i = (y * size + x) * 4;
      px[i] = r / n; px[i + 1] = g / n; px[i + 2] = b / n; px[i + 3] = (a / n) * 255;
    }
  }
  return px;
}

/* ── PNG 로 싼다 ────────────────────────────────────────────
   PNG 는 [서명][IHDR][IDAT][IEND] 이고 각 덩이는 길이·이름·내용·CRC 로 이루어진다.
   화소는 줄마다 「거르개 종류」 한 바이트를 앞에 붙여 zlib 으로 압축한다 — 0 은
   「거르지 않음」이다. 아이콘은 넓은 단색이라 그것만으로도 충분히 줄어든다. */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = buf => {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
};
function chunk(name, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(name, "latin1"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;      // 채널당 8비트
  ihdr[9] = 6;      // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;      // 거르개 없음
    Buffer.from(px.buffer, y * size * 4, size * 4)
      .copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const [name, size, kind] of [
  ["icon-192.png", 192, "round"],
  ["icon-512.png", 512, "round"],
  ["icon-maskable-192.png", 192, "mask"],
  ["icon-maskable-512.png", 512, "mask"],
  // iOS 는 매니페스트의 아이콘을 홈 화면에 쓰지 않는다 — apple-touch-icon 만 본다.
  // 애플이 말하는 크기가 180 이라 그대로 굽는다.
  ["apple-touch-icon.png", 180, "apple"],
]) {
  const buf = png(size, render(size, kind));
  writeFileSync(join(OUT, name), buf);
  console.log(`  ${name.padEnd(24)} ${String(buf.length).padStart(7)} bytes`);
}
