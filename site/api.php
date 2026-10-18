<?php
// agents.mhilo.com — the hosted half of schema/api.md. collector/serve.mjs answers the same routes
// locally, so the page has one code path.
//
//   GET  ?action=whoami                  {authed, local:false, home}: home = on the network the collector pushes from
//   POST ?action=login   {password}      session cookie; 5 wrong tries from an address lock it for 15 min
//   POST ?action=logout
//   GET  ?action=state                   the index (data/index.json), signed in
//   GET  ?action=state&project=<id>      one snapshot, signed in; ETag / If-None-Match → 304
//   POST ?action=push    Bearer <token>  one snapshot from the collector; written atomically, index rebuilt
//
// secret.php (written by tools/set-secret.sh, never in git, denied by .htaccess) returns
//   ['password_hash' => <bcrypt>, 'push_token_sha256' => <hex of sha256(token)>]
// data/ (denied by .htaccess and by its own .htaccess) holds projects/<id>.json, index.json,
// lockout/<sha256(ip)>.json, sessions/ and home.json (hashes of the networks pushes came from). A deploy must exclude data/ and secret.php.
//
// The pattern is evracer-unity's web/billboards/api.php. PHP with no extensions beyond json and
// password_hash.
declare(strict_types=1);
ini_set('display_errors', '0');      // a notice must never land inside the JSON
error_reporting(E_ALL);

const MAX_BYTES = 524288;            // 512 KB per snapshot
const MAX_PROJECTS = 30;             // schema/index.schema.json maxItems
const TRIES = 5;
const LOCK_SECONDS = 900;
const SESSION_SECONDS = 7 * 86400;
// D: `$` means the very end. Without it, '$' also matches before a final newline ("evracer\n").
const ID = '/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/D';
const HEX = '/^#[0-9A-Fa-f]{6}$/D';
const SID = '/^[A-Za-z0-9,-]{22,256}$/D';      // what PHP's session ids can look like
const GLOBAL_FAILS = 50;             // wrong passwords per 15 min from every address together
const HOME_SECONDS = 12 * 3600;      // a network the collector pushed from this recently is "home"
const STATUSES = ['busy', 'idle', 'error', 'stalled'];
define('DATA', __DIR__ . '/data');

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: same-origin');

function out(array $data, int $status = 200): never
{
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function ms(): int
{
    return (int) floor(microtime(true) * 1000);
}

/** data/ and its sub-folders, created on first use, each denied to the web server. */
function dir_of(string $sub = ''): string
{
    $dir = DATA . ($sub === '' ? '' : '/' . $sub);
    if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) out(['error' => 'storage'], 500);
    // Whichever request makes data/ first, it is denied to the web at once (belt to .htaccess's braces).
    if (!is_file(DATA . '/.htaccess')) @file_put_contents(DATA . '/.htaccess', "Require all denied\n");
    return $dir;
}

/** Write a file so a reader sees the old bytes or the new ones, never half of either. */
function write_atomic(string $path, string $bytes): void
{
    $tmp = dirname($path) . '/.tmp-' . bin2hex(random_bytes(8));
    if (@file_put_contents($tmp, $bytes) !== strlen($bytes) || !@rename($tmp, $path)) {
        @unlink($tmp);
        out(['error' => 'storage'], 500);
    }
}

function body(int $limit): string
{
    return (string) file_get_contents('php://input', false, null, 0, $limit);
}

function require_method(string $method): void
{
    $m = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if ($m !== $method && !($method === 'GET' && $m === 'HEAD')) {
        header('Allow: ' . $method);
        out(['error' => 'method'], 405);
    }
}

// ── sessions ────────────────────────────────────────────────────────────────────────────────────

/** Sessions live in data/sessions so their lifetime is ours, not the host's shared cleaner's. */
function session_setup(): void
{
    // Secure is the default; only a local `php -S` test may turn it off, through the environment.
    $secure = getenv('MHILO_AGENTS_INSECURE_COOKIE') !== '1';
    $path = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/')), '/') . '/';
    session_save_path(dir_of('sessions'));
    session_cache_limiter('');       // keep our Cache-Control: no-store (the default would replace it)
    ini_set('session.gc_maxlifetime', (string) SESSION_SECONDS);
    ini_set('session.gc_probability', '1');
    ini_set('session.gc_divisor', '100');
    ini_set('session.use_strict_mode', '1');
    ini_set('session.use_only_cookies', '1');
    session_name('mhagents');
    session_set_cookie_params(['lifetime' => SESSION_SECONDS, 'path' => $path, 'httponly' => true, 'secure' => $secure, 'samesite' => 'Strict']);
}

/**
 * The browser's session cookie, only if it names a session this server holds. An unknown or
 * malformed id is never handed to session_start(), which would mint a new session and a cookie.
 */
function known_session(): bool
{
    $id = $_COOKIE[session_name()] ?? null;
    return is_string($id) && preg_match(SID, $id) === 1 && is_file(session_save_path() . '/sess_' . $id);
}

/** Signed in? Reads an existing session only; never creates one, never issues a cookie. */
function authed(): bool
{
    session_setup();
    if (!known_session()) return false;
    session_start(['read_and_close' => true]);
    return !empty($_SESSION['ok']);
}

/**
 * Who is guessing: the address, an IPv6 one by its /64 (one host usually holds the whole /64).
 * MHILO_AGENTS_TEST_REMOTE_ADDR_HEADER=1 (tests only, set in the environment, never by a request)
 * reads the address from X-Test-Remote-Addr so the tests can play several clients.
 */
function client_key(): string
{
    $ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '?');
    if (getenv('MHILO_AGENTS_TEST_REMOTE_ADDR_HEADER') === '1' && isset($_SERVER['HTTP_X_TEST_REMOTE_ADDR'])) $ip = (string) $_SERVER['HTTP_X_TEST_REMOTE_ADDR'];
    if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6) !== false) {
        $bin = inet_pton($ip);
        if ($bin !== false && strlen($bin) === 16) $ip = bin2hex(substr($bin, 0, 8)) . '::/64';
    }
    return hash('sha256', $ip);
}

/**
 * The visitor's network, for whoami's `home` only: the first address a proxy forwarded, else
 * REMOTE_ADDR, an IPv6 one by its /64, hashed. Never used for the lockout, because a client can
 * forge these headers; forging them only changes which screen is shown — the lab itself still
 * needs the password.
 */
function network_key(): string
{
    $ip = '';
    foreach (['HTTP_CF_CONNECTING_IP', 'HTTP_X_FORWARDED_FOR', 'HTTP_X_REAL_IP', 'REMOTE_ADDR'] as $h) {
        $first = trim(explode(',', (string) ($_SERVER[$h] ?? ''))[0]);
        if (filter_var($first, FILTER_VALIDATE_IP) !== false) { $ip = $first; break; }
    }
    if (getenv('MHILO_AGENTS_TEST_REMOTE_ADDR_HEADER') === '1' && isset($_SERVER['HTTP_X_TEST_REMOTE_ADDR'])) $ip = (string) $_SERVER['HTTP_X_TEST_REMOTE_ADDR'];
    if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6) !== false) {
        $bin = inet_pton($ip);
        if ($bin !== false && strlen($bin) === 16) $ip = bin2hex(substr($bin, 0, 8)) . '::/64';
    }
    return hash('sha256', 'home:' . $ip);
}

/** data/home.json: network hash → when it last pushed (s), only the last HOME_SECONDS. */
function homes(): array
{
    $h = json_decode((string) @file_get_contents(DATA . '/home.json'), true);
    $since = time() - HOME_SECONDS;
    return is_array($h) ? array_filter($h, fn($t, $k) => is_int($t) && $t > $since && is_string($k), ARRAY_FILTER_USE_BOTH) : [];
}

/** Called with the data lock held, after an accepted push. Writes at most once a minute per network. */
function remember_home(): void
{
    $h = homes();
    $key = network_key();
    if (($h[$key] ?? 0) > time() - 60) return;
    $h[$key] = time();
    write_atomic(DATA . '/home.json', json_encode($h));
}

function secret(): array
{
    $file = __DIR__ . '/secret.php';
    $s = is_file($file) ? require $file : null;
    if (!is_array($s) || !is_string($s['password_hash'] ?? null) || !is_string($s['push_token_sha256'] ?? null)) {
        out(['error' => 'setup'], 503);
    }
    return $s;
}

// ── the snapshot check: a pragmatic subset of schema/snapshot.schema.json ───────────────────────

/** Characters, not bytes, with core PCRE (no mbstring); invalid UTF-8 counts as too long. */
function chars(string $s): int { $n = preg_match_all('/./su', $s); return $n === false ? PHP_INT_MAX : $n; }
function is_id(mixed $v): bool { return is_string($v) && preg_match(ID, $v) === 1; }
function is_hex(mixed $v): bool { return is_string($v) && preg_match(HEX, $v) === 1; }
function is_ms(mixed $v): bool { return is_int($v) && $v >= 0; }
function is_ms_or_null(mixed $v): bool { return $v === null || is_ms($v); }
function is_text(mixed $v, int $max, int $min = 0): bool { return is_string($v) && chars($v) >= $min && chars($v) <= $max; }
function is_text_or_null(mixed $v, int $max): bool { return $v === null || is_text($v, $max); }
function is_list_of(mixed $v, int $max): bool { return is_array($v) && array_is_list($v) && count($v) <= $max; }
function is_obj(mixed $v): bool { return is_array($v) && ($v === [] || !array_is_list($v)); }
function is_tokens(mixed $t): bool
{
    return $t === null || (is_obj($t) && shape($t, ['in', 'out', 'cacheRead']) === null && is_ms($t['in']) && is_ms($t['out']) && is_ms($t['cacheRead']));
}

/** The first required key that is missing, or the first key that is not allowed. */
function shape(array $v, array $keys): ?string
{
    foreach ($keys as $k) if (!array_key_exists($k, $v)) return "missing $k";
    foreach (array_keys($v) as $k) if (!in_array($k, $keys, true)) return "unexpected $k";
    return null;
}

function tool_problem(mixed $t): ?string
{
    if ($t === null) return null;
    if (!is_obj($t)) return 'not an object';
    if ($p = shape($t, ['name', 'hint', 'since'])) return $p;
    if (!is_text($t['name'], 64, 1)) return 'name';
    if (!is_text($t['hint'], 60)) return 'hint over 60 characters';
    if (!is_ms($t['since'])) return 'since';
    return null;
}

/** Every string anywhere in the snapshot is at most 120 characters (HARNESS.md §1). */
function longest(mixed $v, int $depth = 0): int
{
    if ($depth > 8) return PHP_INT_MAX;
    if (is_string($v)) return chars($v);
    if (!is_array($v)) return 0;
    $n = 0;
    foreach ($v as $k => $x) $n = max($n, is_string($k) ? chars($k) : 0, longest($x, $depth + 1));
    return $n;
}

/** null when the snapshot is acceptable, else what is wrong with it. */
function snapshot_problem(mixed $s): ?string
{
    if (!is_obj($s)) return 'not an object';
    if ($p = shape($s, ['v', 'project', 'label', 'colour', 'at', 'areas', 'sessions'])) return $p;
    if ($s['v'] !== 1) return 'v must be 1';
    if (!is_id($s['project']) || $s['project'] === 'index') return 'project id';
    if (!is_text($s['label'], 60, 1)) return 'label';
    if (!is_hex($s['colour'])) return 'colour';
    if (!is_ms($s['at'])) return 'at';
    if (!is_list_of($s['areas'], 12)) return 'areas';
    foreach ($s['areas'] as $i => $a) {
        if (!is_obj($a) || shape($a, ['id', 'label', 'tint']) || !is_id($a['id']) || !is_text($a['label'], 60, 1) || !is_hex($a['tint'])) return "areas[$i]";
    }
    if (!is_list_of($s['sessions'], 60)) return 'sessions';
    $sessionKeys = ['id', 'name', 'title', 'cwd', 'branch', 'status', 'startedAt', 'busySince', 'lastActivity', 'model', 'effort', 'costUSD', 'tokens', 'tool', 'area', 'areaWhy', 'agents', 'workflows'];
    $agentKeys = ['id', 'type', 'description', 'model', 'startedAt', 'finishedAt', 'lastActivity', 'tool', 'area', 'depth', 'workflow'];
    foreach ($s['sessions'] as $i => $x) {
        $at = "sessions[$i]";
        if (!is_obj($x)) return $at;
        if ($p = shape($x, $sessionKeys)) return "$at: $p";
        if (!is_id($x['id'])) return "$at.id";
        if (!is_text($x['name'], 120) || !is_text($x['title'], 120) || !is_text($x['areaWhy'], 120)) return "$at: text";
        if (!is_text($x['cwd'], 120) || preg_match('#[/~\\\\:]#', $x['cwd']) !== 0) return "$at.cwd must be a folder name, not a path";
        if (!is_text_or_null($x['branch'], 120)) return "$at.branch";
        if (!in_array($x['status'], STATUSES, true)) return "$at.status";
        if (!is_ms($x['startedAt']) || !is_ms_or_null($x['busySince']) || !is_ms($x['lastActivity'])) return "$at: times";
        if (!is_text_or_null($x['model'], 64) || !is_text_or_null($x['effort'], 16)) return "$at: model or effort";
        if (!($x['costUSD'] === null || ((is_int($x['costUSD']) || is_float($x['costUSD'])) && $x['costUSD'] >= 0))) return "$at.costUSD";
        if (!is_tokens($x['tokens'])) return "$at.tokens";   // null = unknown (schema/api.md)
        if ($p = tool_problem($x['tool'])) return "$at.tool: $p";
        if (!is_id($x['area'])) return "$at.area";
        if (!is_list_of($x['agents'], 200)) return "$at.agents";
        foreach ($x['agents'] as $j => $a) {
            $aat = "$at.agents[$j]";
            if (!is_obj($a)) return $aat;
            if ($p = shape($a, $agentKeys)) return "$aat: $p";
            if (!is_id($a['id']) || !is_text($a['type'], 64, 1) || !is_text($a['description'], 120) || !is_text($a['model'], 64)) return "$aat: text";
            if (!is_ms($a['startedAt']) || !is_ms_or_null($a['finishedAt']) || !is_ms($a['lastActivity'])) return "$aat: times";
            if ($p = tool_problem($a['tool'])) return "$aat.tool: $p";
            if (!is_id($a['area']) || !is_int($a['depth']) || $a['depth'] < 1 || !is_text_or_null($a['workflow'], 64)) return "$aat: area, depth or workflow";
        }
        if (!is_list_of($x['workflows'], 20)) return "$at.workflows";
        foreach ($x['workflows'] as $j => $w) {
            if (!is_obj($w) || shape($w, ['id', 'name', 'status', 'agents', 'startedAt']) || !is_id($w['id']) || !is_text($w['name'], 60, 1)
                || !is_text($w['status'], 32) || !is_ms($w['agents']) || !is_ms($w['startedAt'])) return "$at.workflows[$j]";
        }
    }
    if (longest($s) > 120) return 'a string is over 120 characters';
    return null;
}

/** The tab bar's counts, derived from a snapshot (schema/index.schema.json). */
function counts(array $s): array
{
    $c = ['busy' => 0, 'idle' => 0, 'stalled' => 0, 'error' => 0, 'agents' => 0];
    foreach ($s['sessions'] as $x) {
        if (isset($c[$x['status']])) $c[$x['status']]++;
        foreach ($x['agents'] as $a) if ($a['finishedAt'] === null) $c['agents']++;
    }
    return $c;
}

/**
 * data/index.json from every data/projects/*.json. Called with the data lock held. A project's
 * `at` is when its last push was RECEIVED (feed freshness, schema/api.md): `$pushed` gets now, the
 * others keep the time the previous index recorded (or their file's mtime).
 */
function rebuild_index(string $pushed): void
{
    $was = [];
    $old = json_decode((string) @file_get_contents(DATA . '/index.json'), true);
    foreach (is_array($old['projects'] ?? null) ? $old['projects'] : [] as $p) if (is_array($p) && isset($p['id'], $p['at'])) $was[$p['id']] = $p['at'];
    $now = ms();
    $projects = [];
    foreach (glob(dir_of('projects') . '/*.json') ?: [] as $file) {
        $s = json_decode((string) @file_get_contents($file), true);
        if (!is_array($s) || snapshot_problem($s) !== null) continue;
        $id = $s['project'];
        $at = $id === $pushed ? $now : (is_int($was[$id] ?? null) ? $was[$id] : ((int) @filemtime($file)) * 1000);
        $projects[] = ['id' => $id, 'label' => $s['label'], 'colour' => $s['colour'], 'at' => $at, 'counts' => counts($s)];
    }
    usort($projects, fn($a, $b) => strcmp($a['id'], $b['id']));
    write_atomic(DATA . '/index.json', json_encode(['v' => 1, 'at' => ms(), 'projects' => $projects], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
}

// ── routes ──────────────────────────────────────────────────────────────────────────────────────

$action = $_GET['action'] ?? '';

if ($action === 'whoami') {
    require_method('GET');
    out(['authed' => authed(), 'local' => false, 'home' => isset(homes()[network_key()])]);
}

if ($action === 'login') {
    require_method('POST');
    $secret = secret();
    session_setup();
    // Two gates, read and written under one lock: this address (an IPv6 one by its /64) gets 5
    // wrong tries, then 15 minutes; and all addresses together get GLOBAL_FAILS per 15 minutes,
    // so guessing from many addresses at once is capped too.
    $dir = dir_of('lockout');
    $lock = fopen($dir . '/.lock', 'c');
    if ($lock === false || !flock($lock, LOCK_EX)) out(['error' => 'storage'], 500);
    $read = function (string $file): array {
        $g = json_decode((string) @file_get_contents($file), true);
        return is_array($g) ? $g : [];
    };
    $now = time();
    $recent = fn(array $g) => array_values(array_filter(is_array($g['fails'] ?? null) ? $g['fails'] : [], fn($t) => is_int($t) && $t > $now - LOCK_SECONDS));
    $mine = $dir . '/' . client_key() . '.json';
    $all = $dir . '/global.json';
    $g = $read($mine);
    $until = is_int($g['until'] ?? null) ? $g['until'] : 0;
    $fails = $recent($g);
    $global = $recent($read($all));
    $locked = function (int $wait) use ($lock): never {
        flock($lock, LOCK_UN);
        header('Retry-After: ' . $wait);
        out(['error' => 'locked', 'retryAfter' => $wait], 429);
    };
    if ($until > $now) $locked($until - $now);
    if (count($global) >= GLOBAL_FAILS) $locked(max(1, min($global) + LOCK_SECONDS - $now));

    $given = json_decode(body(4096), true)['password'] ?? null;
    if (is_string($given) && $given !== '' && password_verify($given, $secret['password_hash'])) {
        @unlink($mine);
        flock($lock, LOCK_UN);
        session_start();
        session_regenerate_id(true);
        $_SESSION['ok'] = true;
        $_SESSION['since'] = $now;
        session_write_close();
        out(['ok' => true]);
    }
    $fails[] = $now;
    $global[] = $now;
    $remaining = TRIES - count($fails);
    write_atomic($mine, json_encode($remaining <= 0 ? ['fails' => [], 'until' => $now + LOCK_SECONDS] : ['fails' => $fails, 'until' => 0]));
    write_atomic($all, json_encode(['fails' => $global]));
    flock($lock, LOCK_UN);
    usleep(250000);                  // a wrong guess costs a quarter of a second
    out(['error' => 'wrong', 'remaining' => max(0, $remaining)], 401);
}

if ($action === 'logout') {
    require_method('POST');
    session_setup();
    if (known_session()) {
        session_start();
        $_SESSION = [];
        session_destroy();
        $p = session_get_cookie_params();
        setcookie(session_name(), '', ['expires' => time() - 3600, 'path' => $p['path'], 'secure' => $p['secure'], 'httponly' => true, 'samesite' => 'Strict']);
    }
    out(['ok' => true]);
}

if ($action === 'state') {
    require_method('GET');
    if (!authed()) out(['error' => 'auth'], 401);
    $project = $_GET['project'] ?? null;
    if ($project === null || $project === '') {
        $file = DATA . '/index.json';
        if (!is_file($file)) out(['v' => 1, 'at' => ms(), 'projects' => []]);
        readfile($file);
        exit;
    }
    $file = is_id($project) ? DATA . '/projects/' . $project . '.json' : '';
    if ($file === '' || !is_file($file)) out(['error' => 'unknown project'], 404);
    $bytes = (string) file_get_contents($file);
    $etag = '"' . sha1($bytes) . '"';
    header('ETag: ' . $etag);
    $sent = array_map(fn($t) => trim(preg_replace('~^W/~', '', trim($t))), explode(',', (string) ($_SERVER['HTTP_IF_NONE_MATCH'] ?? '')));
    if (in_array($etag, $sent, true) || in_array('*', $sent, true)) {
        http_response_code(304);
        exit;
    }
    echo $bytes;
    exit;
}

if ($action === 'push') {
    require_method('POST');
    $secret = secret();
    $auth = (string) ($_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
    if ($auth === '' && function_exists('getallheaders')) {
        foreach (getallheaders() as $k => $v) if (strcasecmp((string) $k, 'Authorization') === 0) $auth = (string) $v;
    }
    if (!preg_match('/^Bearer\s+(\S+)$/Di', $auth, $m) || !hash_equals(strtolower($secret['push_token_sha256']), hash('sha256', $m[1]))) {
        usleep(200000);
        out(['error' => 'auth'], 401);
    }
    if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > MAX_BYTES) out(['error' => 'too large', 'max' => MAX_BYTES], 413);
    $raw = body(MAX_BYTES + 1);
    if (strlen($raw) > MAX_BYTES) out(['error' => 'too large', 'max' => MAX_BYTES], 413);
    $snap = json_decode($raw, true, 16);
    if (!is_array($snap)) out(['error' => 'invalid', 'detail' => 'not JSON'], 400);
    $problem = snapshot_problem($snap);
    if ($problem !== null) out(['error' => 'invalid', 'detail' => $problem], 400);

    // One writer at a time: the project file and the index it feeds change together.
    $lock = fopen(dir_of() . '/.lock', 'c');
    if ($lock === false || !flock($lock, LOCK_EX)) out(['error' => 'storage'], 500);
    $file = dir_of('projects') . '/' . $snap['project'] . '.json';
    if (!is_file($file) && count(glob(DATA . '/projects/*.json') ?: []) >= MAX_PROJECTS) {
        flock($lock, LOCK_UN);
        out(['error' => 'invalid', 'detail' => 'already ' . MAX_PROJECTS . ' projects'], 400);
    }
    write_atomic($file, json_encode($snap, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION));
    rebuild_index($snap['project']);
    remember_home();
    flock($lock, LOCK_UN);
    fclose($lock);
    out(['ok' => true]);
}

out(['error' => 'unknown action'], 404);
