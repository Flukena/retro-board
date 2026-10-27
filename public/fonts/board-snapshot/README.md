# Board snapshot fonts

Same-origin copies of the exact Google Fonts families and weights requested by
`index.html`, used to embed font data when exporting a board image. Regenerate with
`node scripts/vendor-snapshot-fonts.mjs` after changing the font link in `index.html`.

- Anuphan: 400, 500, 600, 700; Thai, Latin, Latin Extended, Vietnamese.
- IBM Plex Mono: 400, 500, 600; Latin, Latin Extended, Vietnamese, Cyrillic,
  Cyrillic Extended.
- Caveat: 400, 700; Latin, Latin Extended, Cyrillic, Cyrillic Extended.

`fonts.css` retains the upstream Unicode ranges and uses relative WOFF2 URLs.
The 39 font-face declarations reference 23 unique font files, totaling 409,136
font bytes. Filenames use the first 20 hexadecimal characters of each file's
SHA-256; `manifest.json` includes complete digests, upstream URLs, subset/weight
mappings, the original stylesheet request, and the browser user agent.

All fonts are distributed under the SIL Open Font License 1.1. The original
copyright notices and licenses are preserved in `anuphan-OFL.txt`,
`ibmplexmono-OFL.txt`, and `caveat-OFL.txt`, sourced from the
[official Google Fonts repository](https://github.com/google/fonts/tree/main/ofl).
