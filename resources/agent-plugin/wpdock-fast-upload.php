<?php
/**
 * WPDock Fast Upload Gateway.
 *
 * Standalone HTTPS data plane: deliberately does NOT bootstrap WordPress.
 * WordPress only provisions the short-lived token and later extracts the
 * finalized archive through the regular authenticated agent action.
 */

declare(strict_types=1);

const WPDOCK_FAST_VERSION = 1;
const WPDOCK_FAST_TTL = 86400;

$content_dir = dirname(__DIR__, 2);
$temp_dir = $content_dir . DIRECTORY_SEPARATOR . 'wpdock-temp';
$auth_file = $temp_dir . DIRECTORY_SEPARATOR . 'fast-upload-auth.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, max-age=0');
header('X-Content-Type-Options: nosniff');

function fast_reply(array $data, int $status = 200): void
{
  http_response_code($status);
  echo json_encode($data, JSON_UNESCAPED_SLASHES);
  exit;
}

function fast_success(array $data = array()): void
{
  fast_reply(array('success' => true, 'data' => $data));
}

function fast_error(string $message, int $status = 400): void
{
  fast_reply(array('success' => false, 'message' => $message), $status);
}

function fast_read_json(string $path): ?array
{
  $raw = @file_get_contents($path);
  if ($raw === false) return null;
  $data = json_decode($raw, true);
  return is_array($data) ? $data : null;
}

function fast_write_json(string $path, array $data): bool
{
  $tmp = $path . '.tmp-' . bin2hex(random_bytes(4));
  $ok = @file_put_contents($tmp, json_encode($data, JSON_UNESCAPED_SLASHES), LOCK_EX) !== false
    && @rename($tmp, $path);
  if (! $ok) @unlink($tmp);
  return $ok;
}

function fast_remove_tree(string $dir): void
{
  if (! is_dir($dir)) return;
  $items = @scandir($dir);
  if (is_array($items)) {
    foreach ($items as $item) {
      if ($item === '.' || $item === '..') continue;
      $path = $dir . DIRECTORY_SEPARATOR . $item;
      if (is_dir($path)) fast_remove_tree($path); else @unlink($path);
    }
  }
  @rmdir($dir);
}

function fast_body(): array
{
  $raw = file_get_contents('php://input');
  $data = json_decode($raw === false ? '' : $raw, true);
  return is_array($data) ? $data : array();
}

function fast_clean_resume_key(string $value): string
{
  return preg_replace('/[^a-zA-Z0-9:._-]/', '', substr($value, 0, 180));
}

function fast_session_dir(string $temp_dir, string $resume_key): string
{
  return $temp_dir . DIRECTORY_SEPARATOR . 'fast-' . substr(hash('sha256', $resume_key), 0, 32);
}

function fast_received_indices(string $dir, int $total_chunks): array
{
  $received = array();
  $files = glob($dir . DIRECTORY_SEPARATOR . 'chunk-*.ok');
  if (is_array($files)) {
    foreach ($files as $file) {
      if (preg_match('/chunk-(\d+)\.ok$/', basename($file), $m)) {
        $index = (int) $m[1];
        if ($index >= 0 && $index < $total_chunks) $received[] = $index;
      }
    }
  }
  sort($received, SORT_NUMERIC);
  return $received;
}

function fast_php_upload_error(int $code): string
{
  $map = array(
    UPLOAD_ERR_INI_SIZE => 'exceeds upload_max_filesize',
    UPLOAD_ERR_FORM_SIZE => 'exceeds form limit',
    UPLOAD_ERR_PARTIAL => 'partial upload',
    UPLOAD_ERR_NO_FILE => 'no file',
    UPLOAD_ERR_NO_TMP_DIR => 'missing PHP temp directory',
    UPLOAD_ERR_CANT_WRITE => 'failed to write PHP temp file',
    UPLOAD_ERR_EXTENSION => 'blocked by PHP extension',
  );
  return $map[$code] ?? ('PHP upload error ' . $code);
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
  fast_error('POST required', 405);
}

if (! is_dir($temp_dir) && ! @mkdir($temp_dir, 0750, true)) {
  fast_error('WPDock temp directory is not writable', 507);
}

$auth_raw = @file_get_contents($auth_file);
$auth_json = is_string($auth_raw) ? preg_replace('/^<\?php exit; \?>\s*/', '', $auth_raw) : '';
$auth = json_decode((string) $auth_json, true);
$provided = strtolower(trim((string) ($_SERVER['HTTP_X_WPDOCK_TOKEN'] ?? '')));
if (! is_array($auth)
  || (int) ($auth['expires'] ?? 0) < time()
  || ! preg_match('/^[a-f0-9]{64}$/', $provided)
  || ! hash_equals((string) ($auth['token'] ?? ''), $provided)
) {
  fast_error('Invalid or expired token', 403);
}

$action = preg_replace('/[^a-z_]/', '', (string) ($_GET['action'] ?? ''));

if ($action === 'ping') {
  fast_success(array('version' => WPDOCK_FAST_VERSION));
}

if ($action === 'init') {
  $body = fast_body();
  $filename = basename((string) ($body['filename'] ?? 'upload.zip'));
  $extension = strtolower(pathinfo($filename, PATHINFO_EXTENSION));
  $total_chunks = (int) ($body['total_chunks'] ?? 0);
  $total_bytes = (int) ($body['total_bytes'] ?? 0);
  $chunk_size = (int) ($body['chunk_size'] ?? 0);
  $resume_key = fast_clean_resume_key((string) ($body['resume_key'] ?? ''));
  if (! in_array($extension, array('zip', 'sql'), true)
    || $total_chunks < 1 || $total_bytes < 1 || $chunk_size < 1 || $resume_key === ''
  ) {
    fast_error('Invalid upload metadata');
  }

  $session_dir = fast_session_dir($temp_dir, $resume_key);
  $completed_file = $temp_dir . DIRECTORY_SEPARATOR . 'fast-completed-' . basename($session_dir) . '.json';
  $completed = fast_read_json($completed_file);
  if (is_array($completed) && (int) ($completed['expires'] ?? 0) >= time()) {
    $token = preg_replace('/[^a-f0-9]/', '', (string) ($completed['token'] ?? ''));
    $token_data = $token !== '' ? fast_read_json($temp_dir . DIRECTORY_SEPARATOR . 'tok-' . $token . '.json') : null;
    $path = is_array($token_data) ? (string) ($token_data['path'] ?? '') : '';
    if ($path !== '' && file_exists($path)) {
      fast_success(array('file_token' => $token, 'completed' => true, 'resumed' => true));
    }
    @unlink($completed_file);
  }

  $state_file = $session_dir . DIRECTORY_SEPARATOR . 'state.json';
  $state = fast_read_json($state_file);
  $compatible = is_array($state)
    && (string) ($state['resume_key'] ?? '') === $resume_key
    && (int) ($state['total_chunks'] ?? 0) === $total_chunks
    && (int) ($state['total_bytes'] ?? 0) === $total_bytes
    && (int) ($state['chunk_size'] ?? 0) === $chunk_size;

  if (! $compatible) {
    fast_remove_tree($session_dir);
    if (! @mkdir($session_dir, 0750, true)) fast_error('Cannot create upload session', 507);
    $state = array(
      'resume_key' => $resume_key,
      'filename' => $filename,
      'total_chunks' => $total_chunks,
      'total_bytes' => $total_bytes,
      'chunk_size' => $chunk_size,
      'expires' => time() + WPDOCK_FAST_TTL,
    );
    if (! fast_write_json($state_file, $state)) fast_error('Cannot store upload state', 507);
    $target = @fopen($session_dir . DIRECTORY_SEPARATOR . 'upload.part', 'c+b');
    if ($target === false) fast_error('Cannot create upload target', 507);
    fclose($target);
  } else {
    $state['expires'] = time() + WPDOCK_FAST_TTL;
    fast_write_json($state_file, $state);
  }

  $received = fast_received_indices($session_dir, $total_chunks);
  fast_success(array(
    'upload_id' => basename($session_dir),
    'received_indices' => $received,
    'received_chunks' => count($received),
    'resumed' => count($received) > 0,
  ));
}

if ($action === 'chunk') {
  $upload_id = preg_replace('/[^a-z0-9-]/', '', (string) ($_POST['upload_id'] ?? ''));
  $index = isset($_POST['chunk_index']) ? (int) $_POST['chunk_index'] : -1;
  if (! preg_match('/^fast-[a-f0-9]{32}$/', $upload_id) || $index < 0) fast_error('Invalid chunk metadata');
  $session_dir = $temp_dir . DIRECTORY_SEPARATOR . $upload_id;
  $state = fast_read_json($session_dir . DIRECTORY_SEPARATOR . 'state.json');
  if (! is_array($state) || (int) ($state['expires'] ?? 0) < time()) fast_error('Upload session not found or expired', 410);
  if ($index >= (int) $state['total_chunks']) fast_error('Chunk index out of range');
  if (! isset($_FILES['chunk'])) fast_error('Chunk missing');
  $error = (int) ($_FILES['chunk']['error'] ?? UPLOAD_ERR_NO_FILE);
  if ($error !== UPLOAD_ERR_OK) fast_error(fast_php_upload_error($error), 413);

  $expected = min(
    (int) $state['chunk_size'],
    (int) $state['total_bytes'] - $index * (int) $state['chunk_size']
  );
  $tmp = (string) $_FILES['chunk']['tmp_name'];
  if ($expected < 1 || (int) @filesize($tmp) !== $expected) fast_error('Chunk size mismatch');
  $expected_hash = strtolower((string) ($_POST['chunk_sha256'] ?? ''));
  if ($expected_hash !== '' && ! hash_equals($expected_hash, hash_file('sha256', $tmp))) {
    fast_error('Chunk sha256 mismatch', 422);
  }

  $source = @fopen($tmp, 'rb');
  $target = @fopen($session_dir . DIRECTORY_SEPARATOR . 'upload.part', 'c+b');
  if ($source === false || $target === false) fast_error('Cannot open chunk storage', 507);
  if (@fseek($target, $index * (int) $state['chunk_size']) !== 0) fast_error('Cannot seek upload target', 507);
  $written = 0;
  while (! feof($source)) {
    $buffer = fread($source, 1024 * 1024);
    if ($buffer === false) break;
    $length = strlen($buffer);
    if ($length === 0) continue;
    $offset = 0;
    while ($offset < $length) {
      $n = fwrite($target, substr($buffer, $offset));
      if ($n === false || $n === 0) fast_error('Cannot write chunk data', 507);
      $offset += $n;
      $written += $n;
    }
  }
  fflush($target);
  fclose($source);
  fclose($target);
  if ($written !== $expected) fast_error('Incomplete chunk write', 507);
  if (@file_put_contents($session_dir . DIRECTORY_SEPARATOR . 'chunk-' . $index . '.ok', (string) $expected, LOCK_EX) === false) {
    fast_error('Cannot mark uploaded chunk', 507);
  }
  fast_success(array('chunk_index' => $index, 'bytes' => $written));
}

if ($action === 'finalize') {
  $body = fast_body();
  $upload_id = preg_replace('/[^a-z0-9-]/', '', (string) ($body['upload_id'] ?? ''));
  if (! preg_match('/^fast-[a-f0-9]{32}$/', $upload_id)) fast_error('Invalid upload id');
  $session_dir = $temp_dir . DIRECTORY_SEPARATOR . $upload_id;
  $state = fast_read_json($session_dir . DIRECTORY_SEPARATOR . 'state.json');
  if (! is_array($state)) fast_error('Upload session not found or expired', 410);
  $received = fast_received_indices($session_dir, (int) $state['total_chunks']);
  if (count($received) !== (int) $state['total_chunks']) fast_error('Upload is incomplete', 409);
  $target = $session_dir . DIRECTORY_SEPARATOR . 'upload.part';
  if ((int) @filesize($target) !== (int) $state['total_bytes']) fast_error('Final file size mismatch', 422);
  if (preg_match('/^sha256:([a-f0-9]{64}):/i', (string) $state['resume_key'], $m)
    && ! hash_equals(strtolower($m[1]), hash_file('sha256', $target))
  ) {
    fast_remove_tree($session_dir);
    fast_error('Final file sha256 mismatch; session reset', 422);
  }

  $extension = strtolower(pathinfo((string) $state['filename'], PATHINFO_EXTENSION));
  $final_path = $temp_dir . DIRECTORY_SEPARATOR . 'upload-fast-' . bin2hex(random_bytes(12)) . '.' . $extension;
  if (! @rename($target, $final_path)) fast_error('Cannot finalize upload file', 507);
  $token = bin2hex(random_bytes(16));
  if (! fast_write_json($temp_dir . DIRECTORY_SEPARATOR . 'tok-' . $token . '.json', array(
    'path' => $final_path,
    'expires' => time() + WPDOCK_FAST_TTL,
  ))) {
    @unlink($final_path);
    fast_error('Cannot store file token', 507);
  }
  fast_write_json($temp_dir . DIRECTORY_SEPARATOR . 'fast-completed-' . $upload_id . '.json', array(
    'token' => $token,
    'expires' => time() + WPDOCK_FAST_TTL,
  ));
  fast_remove_tree($session_dir);
  fast_success(array('file_token' => $token, 'file_size' => (int) $state['total_bytes']));
}

if ($action === 'abort') {
  $body = fast_body();
  $upload_id = preg_replace('/[^a-z0-9-]/', '', (string) ($body['upload_id'] ?? ''));
  if (preg_match('/^fast-[a-f0-9]{32}$/', $upload_id)) {
    fast_remove_tree($temp_dir . DIRECTORY_SEPARATOR . $upload_id);
  }
  fast_success(array('aborted' => true));
}

fast_error('Unknown action', 404);
