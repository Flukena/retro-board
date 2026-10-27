// Copy the Google Fonts families requested by index.html into
// public/fonts/board-snapshot so board-image export can embed same-origin fonts.
// Run after changing the font link in index.html: node scripts/vendor-snapshot-fonts.mjs
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT_URL = new URL('../', import.meta.url);
const OUTPUT_URL = new URL('public/fonts/board-snapshot/', ROOT_URL);
const GOOGLE_FONTS_HREF_PATTERN = /href="(https:\/\/fonts\.googleapis\.com\/css2\?[^"]+)"/;
const FONT_FACE_PATTERN = /\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g;
const FONT_URL_PATTERN = /url\(([^)]+)\)/;
// Google serves WOFF2 with per-script unicode-range subsets only to modern browsers.
const CHROME_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
const FILE_HASH_PREFIX_LENGTH = 20;
const LICENSE_URL = (slug) => `https://raw.githubusercontent.com/google/fonts/main/ofl/${slug}/OFL.txt`;
const JSON_INDENT_SPACES = 2;

export const familySlug = (family) => family.toLowerCase().replaceAll(/[^a-z0-9]/g, '');

export function fontStylesheetURL(indexHTML) {
  const match = indexHTML.match(GOOGLE_FONTS_HREF_PATTERN);
  if (!match) throw new Error('index.html has no Google Fonts stylesheet link');
  return match[1].replaceAll('&amp;', '&');
}

const declaration = (body, name) => body.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim();

export function parseFontFaces(css) {
  return [...css.matchAll(FONT_FACE_PATTERN)].map(([, subset, body]) => ({
    subset,
    family: declaration(body, 'font-family').replaceAll("'", ''),
    weight: declaration(body, 'font-weight'),
    url: declaration(body, 'src').match(FONT_URL_PATTERN)[1],
  }));
}

export const hashedFileName = (bytes) =>
  `${createHash('sha256').update(bytes).digest('hex').slice(0, FILE_HASH_PREFIX_LENGTH)}.woff2`;

export function relativeStylesheet(css, fileByURL) {
  return css.replace(/url\(([^)]+)\)/g, (whole, url) => (fileByURL.has(url) ? `url(./${fileByURL.get(url)})` : whole));
}

async function fetchOK(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response;
}

async function downloadFonts(faces) {
  const fonts = new Map();
  for (const { url } of faces) {
    if (fonts.has(url)) continue;
    const bytes = Buffer.from(await (await fetchOK(url)).arrayBuffer());
    const file = hashedFileName(bytes);
    writeFileSync(new URL(file, OUTPUT_URL), bytes);
    fonts.set(url, { url, file, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
  }
  return fonts;
}

async function downloadLicenses(families) {
  const licenses = {};
  for (const family of families) {
    const slug = familySlug(family);
    licenses[slug] = LICENSE_URL(slug);
    writeFileSync(new URL(`${slug}-OFL.txt`, OUTPUT_URL), await (await fetchOK(licenses[slug])).text());
  }
  return licenses;
}

function removeStaleFiles(keep) {
  for (const name of readdirSync(OUTPUT_URL)) {
    const vendored = name.endsWith('.woff2') || name.endsWith('-OFL.txt');
    if (vendored && !keep.has(name)) rmSync(new URL(name, OUTPUT_URL));
  }
}

async function main() {
  const cssSourceUrl = fontStylesheetURL(readFileSync(new URL('index.html', ROOT_URL), 'utf8'));
  const css = await (await fetchOK(cssSourceUrl, { headers: { 'user-agent': CHROME_USER_AGENT } })).text();
  const faces = parseFontFaces(css);
  const fonts = await downloadFonts(faces);
  const families = [...new Set(faces.map((face) => face.family))];
  const licenses = await downloadLicenses(families);
  const fileByURL = new Map([...fonts].map(([url, font]) => [url, font.file]));
  writeFileSync(new URL('fonts.css', OUTPUT_URL), relativeStylesheet(css, fileByURL));
  const manifest = {
    cssSourceUrl, userAgent: CHROME_USER_AGENT, licenses, fonts: [...fonts.values()],
    faces: faces.map(({ family, weight, subset, url }) => ({ family, weight, subset, file: fileByURL.get(url) })),
  };
  writeFileSync(new URL('manifest.json', OUTPUT_URL), `${JSON.stringify(manifest, null, JSON_INDENT_SPACES)}\n`);
  removeStaleFiles(new Set([...fileByURL.values(), ...families.map((family) => `${familySlug(family)}-OFL.txt`)]));
  const totalBytes = manifest.fonts.reduce((sum, font) => sum + font.bytes, 0);
  console.log(`${faces.length} faces, ${fonts.size} files, ${totalBytes} bytes: ${families.join(', ')}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
