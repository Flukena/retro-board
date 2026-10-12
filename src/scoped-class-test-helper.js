const CLASS_NAME_PATTERN = /className=(?:"([^"]+)"|\{([^}]+)\})/g;
const STRING_LITERAL_PATTERN = /['"]([^'"]+)['"]/g;
const CSS_CLASS_PATTERN = /\.([a-z][\w-]*)/g;

export function classGroups(source) {
  return [...source.matchAll(CLASS_NAME_PATTERN)].flatMap((match) => {
    const values = match[1] ? [match[1]] : [...match[2].matchAll(STRING_LITERAL_PATTERN)].map((literal) => literal[1]);
    return values.map((value) => new Set(value.split(/\s+/)));
  });
}

export function targetsClass(selector, className, elementClasses) {
  const lastCompound = selector.trim().split(/[\s>+~]+/).at(-1);
  const requiredClasses = [...lastCompound.matchAll(CSS_CLASS_PATTERN)].map((match) => match[1]);
  return requiredClasses.includes(className) && requiredClasses.every((required) => elementClasses.has(required));
}

