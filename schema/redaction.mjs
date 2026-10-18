// HARNESS.md §1 as code: the redaction rules every snapshot must pass. Imported by
// collector/snapshot.mjs before emitting, and by the sensors via tests/redaction.mjs.

// Exported so collector/snapshot.mjs masks exactly what this flags.
export const KEY_MATERIAL = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{20,}/,            // API-key shaped
  /\b[0-9a-f]{64}\b/,                   // the registry's .key suffix / lock tokens
  /authToken|"token"\s*:/i,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,       // AWS access key id
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,     // Slack
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,        // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,          // GitLab
  /\bAIza[0-9A-Za-z_-]{30,}/,            // Google API key
  /\bnpm_[A-Za-z0-9]{30,}/,              // npm
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // JWT
  /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i, // credentials in a URL
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/i, // an Authorization header value
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\s*[=:]\s*[^\s,;]+/i, // key=value / key: value
];

// Returns a list of problems; empty means the value is clean.
export function redactionProblems(value, path = '$') {
  const out = [];
  if (typeof value === 'string') {
    if (value.length > 120) out.push(`${path}: ${value.length} chars (> 120)`);
    if (/\.tool\.hint$/.test(path) && value.length > 60) out.push(`${path}: hint ${value.length} chars (> 60)`);
    if (/^(\/|~\/)/.test(value) || /\/Users\/|\/home\//.test(value)) out.push(`${path}: absolute path`);
    if (/(^|[\s('"`=])([A-Za-z]:[\\/]|\\\\)/.test(value) || /\\Users\\/i.test(value)) out.push(`${path}: absolute Windows path`);
    if (/\.\.[\\/]/.test(value)) out.push(`${path}: path leaves the root`);
    for (const re of KEY_MATERIAL) if (re.test(value)) out.push(`${path}: looks like key material`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => out.push(...redactionProblems(v, `${path}[${i}]`)));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) out.push(...redactionProblems(v, `${path}.${k}`));
  }
  return out;
}
