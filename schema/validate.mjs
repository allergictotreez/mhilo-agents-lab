// A stdlib-only validator for the JSON-schema subset used in schema/*.json:
// type, required, properties, additionalProperties:false, items, enum, minLength,
// maxLength, pattern, minimum, maxItems, and $ref to #/$defs/<name>.
// Works in node and the browser (no imports). Returns a list of "path: problem" strings.

export function validate(schema, value, root = schema, path = '$') {
  const errors = [];
  if (schema.$ref) {
    const name = schema.$ref.replace(/^#\/\$defs\//, '');
    const target = root.$defs?.[name];
    if (!target) return [`${path}: unknown $ref ${schema.$ref}`];
    return validate(target, value, root, path);
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(t => is(t, value))) {
      return [`${path}: expected ${types.join('|')}, got ${kind(value)}`];
    }
  }
  if (value === null) return errors;

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} not in ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength} (${value.length})`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${path}: below ${schema.minimum}`);
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => errors.push(...validate(schema.items, v, root, `${path}[${i}]`)));
  } else if (typeof value === 'object') {
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${path}: missing ${key}`);
    }
    const props = schema.properties || {};
    for (const [key, v] of Object.entries(value)) {
      if (props[key]) errors.push(...validate(props[key], v, root, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected ${key}`);
    }
  }
  return errors;
}

function is(type, v) {
  switch (type) {
    case 'null': return v === null;
    case 'array': return Array.isArray(v);
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'integer': return Number.isInteger(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    default: return typeof v === type;
  }
}

function kind(v) {
  return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
}
