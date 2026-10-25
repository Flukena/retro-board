const CHANNEL_MAX = 255;
const ALPHA_OPAQUE = 1;
const HEX_RADIX = 16;
const HEX_SHORT_LENGTH = 3;
const HEX_CHANNEL_LENGTH = 2;
const RGB_CHANNEL_COUNT = 3;
const RGBA_CHANNEL_COUNT = 4;
const SRGB_LINEAR_THRESHOLD = 0.04045;
const SRGB_LINEAR_DIVISOR = 12.92;
const SRGB_OFFSET = 0.055;
const SRGB_SCALE = 1.055;
const SRGB_EXPONENT = 2.4;
const LUMINANCE_RED_WEIGHT = 0.2126;
const LUMINANCE_GREEN_WEIGHT = 0.7152;
const LUMINANCE_BLUE_WEIGHT = 0.0722;
const CONTRAST_OFFSET = 0.05;
const DECIMAL_COMPONENT = /^(?:\d+(?:\.\d+)?|\.\d+)$/;

function validateColor(color) {
  if (!color || ![color.r, color.g, color.b].every((channel) => (
    Number.isFinite(channel) && channel >= 0 && channel <= CHANNEL_MAX
  )) || !Number.isFinite(color.a) || color.a < 0 || color.a > ALPHA_OPAQUE) {
    throw new Error('Invalid color channels or alpha');
  }
  return color;
}

function parseFunctionalColor(input) {
  const match = /^(rgb|rgba)\(\s*([^)]*)\s*\)$/.exec(input);
  if (!match) throw new Error('Unsupported color syntax');
  const parts = match[2].split(',').map((part) => part.trim());
  const count = match[1] === 'rgb' ? RGB_CHANNEL_COUNT : RGBA_CHANNEL_COUNT;
  if (parts.length !== count || !parts.every((part) => DECIMAL_COMPONENT.test(part))) {
    throw new Error('Invalid color components');
  }
  const [r, g, b, a = ALPHA_OPAQUE] = parts.map(Number);
  return validateColor({ r, g, b, a });
}

export function parseColor(str) {
  if (typeof str !== 'string') throw new Error('Color must be a string');
  const input = str.trim();
  const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(input);
  if (!hex) return parseFunctionalColor(input);
  const digits = hex[1].length === HEX_SHORT_LENGTH
    ? [...hex[1]].map((digit) => digit.repeat(HEX_CHANNEL_LENGTH)).join('') : hex[1];
  const channels = digits.match(/../g).map((channel) => Number.parseInt(channel, HEX_RADIX));
  const [r, g, b] = channels;
  return { r, g, b, a: ALPHA_OPAQUE };
}

function asColor(value) {
  return typeof value === 'string' ? parseColor(value) : validateColor(value);
}

function linearChannel(channel) {
  const srgb = channel / CHANNEL_MAX;
  return srgb <= SRGB_LINEAR_THRESHOLD ? srgb / SRGB_LINEAR_DIVISOR
    : ((srgb + SRGB_OFFSET) / SRGB_SCALE) ** SRGB_EXPONENT;
}

export function relativeLuminance({ r, g, b }) {
  validateColor({ r, g, b, a: ALPHA_OPAQUE });
  return LUMINANCE_RED_WEIGHT * linearChannel(r)
    + LUMINANCE_GREEN_WEIGHT * linearChannel(g)
    + LUMINANCE_BLUE_WEIGHT * linearChannel(b);
}

export function contrastRatio(fg, bg) {
  const foreground = asColor(fg);
  const background = asColor(bg);
  if (foreground.a < ALPHA_OPAQUE || background.a < ALPHA_OPAQUE) {
    throw new Error('Contrast requires opaque colors; composite first');
  }
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + CONTRAST_OFFSET) / (Math.min(first, second) + CONTRAST_OFFSET);
}

export function compositeOver(fg, bg) {
  const foreground = asColor(fg);
  const background = asColor(bg);
  if (background.a !== ALPHA_OPAQUE) throw new Error('Compositing requires an opaque background');
  const blend = (channel) => foreground[channel] * foreground.a
    + background[channel] * (ALPHA_OPAQUE - foreground.a);
  return { r: blend('r'), g: blend('g'), b: blend('b'), a: ALPHA_OPAQUE };
}
