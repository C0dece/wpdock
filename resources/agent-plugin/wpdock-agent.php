<?php

/**
 * Plugin Name: WPDock Agent
 * Plugin URI:  https://github.com/wpdock/wpdock
 * Description: Secure agent plugin for WPDock VS Code extension — enables file/DB sync without FTP.
 * Version:     1.3.9
 * Author:      WPDock
 * License:     GPL-2.0-or-later
 */

if (! defined('ABSPATH')) {
  exit;
}

define('WPDOCK_AGENT_VERSION', '1.3.9');
define('WPDOCK_TEMP_DIR', WP_CONTENT_DIR . '/wpdock-temp');

// Bootstrap on init
add_action('init', 'wpdock_agent_handle_request', 1);

function wpdock_agent_handle_request()
{
  if (! isset($_GET['wpdock-agent'])) {
    return;
  }

  // Verify token (SHA256 of the admin application password)
  $token = $_SERVER['HTTP_X_WPDOCK_TOKEN'] ?? '';
  if (! wpdock_verify_token($token)) {
    wpdock_json_error('Invalid or missing token', 403);
  }

  $action = sanitize_key($_GET['action'] ?? '');

  switch ($action) {
    case 'ping':
      wpdock_json_success(array('version' => WPDOCK_AGENT_VERSION));
      break;

    case 'pack_files':
      wpdock_pack_files();
      break;

    case 'list_files':
      wpdock_list_files();
      break;

    case 'export_db':
      wpdock_export_db();
      break;

    case 'upload':
      wpdock_handle_upload();
      break;

    case 'upload_init':
      wpdock_upload_init();
      break;

    case 'upload_chunk':
      wpdock_upload_chunk();
      break;

    case 'upload_finalize':
      wpdock_upload_finalize();
      break;

    case 'extract_files':
      wpdock_extract_files();
      break;

    case 'import_db':
      wpdock_import_db();
      break;

    case 'download':
      wpdock_download_file();
      break;

    case 'get_part':
      wpdock_get_part();
      break;

    case 'ack_part':
      wpdock_ack_part();
      break;

    case 'pack_status':
      wpdock_pack_status();
      break;

    case 'reset_wp':
      wpdock_reset_wp();
      break;

    default:
      wpdock_json_error('Unknown action: ' . $action, 400);
  }
}

// ── Token verification ────────────────────────────────────────────────────────

function wpdock_verify_token(string $token): bool
{
  if (empty($token) || strlen($token) !== 64) {
    return false;
  }

  // Fetch all application passwords for all admins
  $admins = get_users(array('role' => 'administrator'));
  foreach ($admins as $admin) {
    $passwords = WP_Application_Passwords::get_user_application_passwords($admin->ID);
    foreach ($passwords as $app_pass) {
      // The stored password is hashed; we compare token = sha256(raw_password)
      // Token is sent by extension as sha256(appPassword)
      // We verify by checking if any stored app password hash matches
      // (Application passwords are stored as bcrypt — we can't reverse them)
      // Instead, validate by issuing a REST request using HTTP Basic Auth internally
      // Simple approach: store the expected token hash in a transient on first auth
    }
  }

  // Fallback: verify via transient set during first successful REST API auth
  $stored = get_transient('wpdock_agent_token');
  if ($stored && hash_equals($stored, $token)) {
    return true;
  }

  // Try to register the token via REST auth verification
  return wpdock_try_register_token($token);
}

function wpdock_try_register_token(string $token): bool
{
  // If the token was never registered, reject. Extension must call installAgent first
  // which goes through WP REST API authentication and stores the token.
  return false;
}

// Called by REST API endpoint (authenticated) to register the token
add_action('rest_api_init', function () {
  register_rest_route('wpdock/v1', '/register-token', array(
    'methods'             => 'POST',
    'callback'            => 'wpdock_register_token_endpoint',
    'permission_callback' => function () {
      return current_user_can('manage_options');
    },
  ));
});

function wpdock_register_token_endpoint(WP_REST_Request $request): WP_REST_Response
{
  $token = sanitize_text_field($request->get_param('token'));
  if (strlen($token) !== 64) {
    return new WP_REST_Response(array('error' => 'Invalid token format'), 400);
  }
  set_transient('wpdock_agent_token', $token, DAY_IN_SECONDS * 30);
  return new WP_REST_Response(array('success' => true));
}

// ── Actions ───────────────────────────────────────────────────────────────────

/**
 * Pack wp-content into a ZIP incrementally across several short requests.
 *
 * Big sites cannot be zipped in one request: the host's PHP-FPM
 * (request_terminate_timeout) or reverse proxy (read timeout) drops the
 * connection — commonly at ~300s — producing a "socket hang up". To stay under
 * that wall we never run one long request:
 *
 *   - START   (no job_id): build a file manifest once, return {job_id, total}.
 *   - CONTINUE (job_id):    pack the next bounded batch into its OWN small ZIP
 *                           part and return {done, processed, total, part_token,
 *                           part_size}; the client downloads + extracts each part
 *                           immediately. The last batch sets done:true.
 *
 * Each batch is a fresh ZIP — we never re-open and re-write one growing archive
 * (ZipArchive::open(CREATE) rewrites the whole file on close, an O(n²) cost that
 * stalled 100k+ file sites mid-pack). The client polls CONTINUE until done. Each
 * request processes at most $MAX_FILES files / $MAX_BYTES bytes (see
 * wpdock_pack_files_continue), so it stays far below any host execution cap
 * regardless of site size, and server disk never holds more than one part.
 */
function wpdock_pack_files(): void
{
  @set_time_limit(0);
  @ignore_user_abort(true);

  $input  = json_decode(file_get_contents('php://input'), true);
  if (! is_array($input)) {
    $input = array();
  }
  $job_id = isset($input['job_id']) ? preg_replace('/[^a-f0-9]/i', '', (string) $input['job_id']) : '';

  if ($job_id === '') {
    wpdock_pack_files_start($input);
  } else {
    // Parallel shards (agent ≥1.3.5): each shard owns a disjoint manifest slice
    // and its own cursor file, so K of them pack+stream concurrently. `shard`
    // absent → the legacy single-cursor path (old clients stay compatible).
    $shard = isset($input['shard']) ? (int) $input['shard'] : -1;
    // Resumable clients (agent ≥1.3.7) download parts by sequence via get_part
    // and ack_part to free disk, so they ask us to skip the per-part token. Old
    // clients omit the flag → token-based `download` path, unchanged.
    $seq_dl = ! empty($input['seq_dl']);
    wpdock_pack_files_continue($job_id, $shard, $seq_dl);
  }
}

/**
 * Atomically persist `$data` as JSON to `$file`: write to a unique temp file in
 * the same directory then rename() over the target. A reader therefore always
 * sees either the previous complete JSON or the new one — never an empty/torn
 * file (the cause of spurious "Pack job state corrupted").
 */
function wpdock_write_json_atomic(string $file, $data): bool
{
  $json = wp_json_encode($data);
  if ($json === false) {
    return false;
  }
  $tmp = $file . '.tmp-' . getmypid() . '-' . mt_rand(1000, 9999);
  if (file_put_contents($tmp, $json, LOCK_EX) === false) {
    @unlink($tmp);
    return false;
  }
  if (! @rename($tmp, $file)) {
    if (! @copy($tmp, $file)) {
      @unlink($tmp);
      return false;
    }
    @unlink($tmp);
  }
  return true;
}

/** Read a JSON object from `$file`, tolerating a transient empty/torn read by
 *  retrying once after a brief pause (a concurrent atomic write landing). */
function wpdock_read_json_array(string $file)
{
  for ($i = 0; $i < 2; $i++) {
    $raw = @file_get_contents($file);
    if ($raw !== false && $raw !== '') {
      $data = json_decode($raw, true);
      if (is_array($data)) {
        return $data;
      }
    }
    usleep(50000); // 50ms
  }
  return null;
}

function wpdock_pack_files_start(array $input): void
{
  $exclude = (isset($input['exclude']) && is_array($input['exclude'])) ? $input['exclude'] : array();

  // Always exclude the WPDock agent plugin itself so it is never transferred
  // between environments and cannot accidentally overwrite the installed version.
  $exclude[] = 'wp-content/plugins/wpdock-agent';

  wpdock_ensure_temp_dir();
  $id            = bin2hex(random_bytes(8));
  $manifest_file = WPDOCK_TEMP_DIR . '/pack-' . $id . '.manifest';
  $job_file      = WPDOCK_TEMP_DIR . '/pack-' . $id . '.job';

  $wp_content = WP_CONTENT_DIR;
  $files = new RecursiveIteratorIterator(
    new RecursiveDirectoryIterator($wp_content, RecursiveDirectoryIterator::SKIP_DOTS),
    RecursiveIteratorIterator::SELF_FIRST
  );

  $fh = fopen($manifest_file, 'w');
  if ($fh === false) {
    wpdock_json_error('Cannot create pack manifest', 500);
  }

  $total = 0;
  foreach ($files as $file) {
    $real_path = $file->getRealPath();
    if ($real_path === false) {
      continue;
    }
    $rel_path = 'wp-content/' . ltrim(str_replace($wp_content, '', $real_path), DIRECTORY_SEPARATOR);
    $rel_path = str_replace('\\', '/', $rel_path);

    foreach ($exclude as $excl) {
      if ($excl !== '' && strpos($rel_path, $excl) !== false) {
        continue 2;
      }
    }

    // Manifest is tab/newline-delimited; skip the pathological paths that would
    // break it (extremely rare on real installs).
    if (strpbrk($rel_path, "\t\n") !== false || strpbrk($real_path, "\t\n") !== false) {
      continue;
    }

    $type = $file->isDir() ? 'D' : 'F';
    $size = ($type === 'F') ? (int) $file->getSize() : 0;
    fwrite($fh, $type . "\t" . $size . "\t" . $real_path . "\t" . $rel_path . "\n");
    $total++;
  }
  fclose($fh);

  $job = array(
    'manifest' => $manifest_file,
    'total'    => $total,
    'index'    => 0,
    'offset'   => 0,
    'parts'    => 0,
    'bytes'    => 0,
  );
  if (! wpdock_write_json_atomic($job_file, $job)) {
    @unlink($manifest_file);
    wpdock_json_error('Cannot persist pack job state', 500);
  }

  // Parallel shards: split the manifest into K disjoint line-ranges, each with
  // its OWN cursor file, so the client can pack+download K of them at once. Most
  // shared hosts throttle a single connection but allow several, so K concurrent
  // streams multiply throughput. Skip sharding for small pulls where the extra
  // WP bootstraps would cost more than they save.
  $shards = ($total < 2000) ? 1 : (($total < 8000) ? 3 : 6);
  if ($shards > 1) {
    $shard_size = (int) ceil($total / $shards);
    // One linear pass records the byte offset where each shard's slice begins.
    $starts = array(0 => 0);
    $sfh = fopen($manifest_file, 'r');
    if ($sfh !== false) {
      $line_no = 0;
      for ($s = 1; $s < $shards; $s++) {
        $target = $s * $shard_size;
        while ($line_no < $target && fgets($sfh) !== false) {
          $line_no++;
        }
        $starts[$s] = ftell($sfh);
      }
      fclose($sfh);
      for ($s = 0; $s < $shards; $s++) {
        $start_idx = $s * $shard_size;
        $end_idx   = min(($s + 1) * $shard_size, $total);
        wpdock_write_json_atomic(WPDOCK_TEMP_DIR . '/pack-' . $id . '-s' . $s . '.job', array(
          'manifest' => $manifest_file,
          'total'    => $total,
          'start'    => $start_idx,
          'end'      => $end_idx,
          'index'    => $start_idx,
          'offset'   => $starts[$s],
          'parts'    => 0,
          'bytes'    => 0,
        ));
      }
    } else {
      $shards = 1; // couldn't reopen manifest for sharding; fall back to one stream
    }
  }

  error_log('[WPDock] pack_files START job=' . $id . ' total=' . $total . ' shards=' . $shards);
  wpdock_json_success(array(
    'job_id' => $id,
    'total'  => $total,
    'shards' => $shards,
    'done'   => false,
  ));
}

/**
 * list_files — build a flat manifest of a wp-content subtree (default: uploads)
 * so the client can download those files DIRECTLY over HTTP (public static URLs),
 * bypassing PHP entirely. This is how media (the bulk of a pull) is transferred
 * fast and resumably: the client compares each manifest size against what is
 * already on disk and only fetches what is missing.
 *
 * Each manifest line is `rel\tsize`, where `rel` is relative to wp-content
 * (e.g. `uploads/2024/01/img.jpg`). The public URL is `content_base_url/rel`.
 * The manifest itself is served via a one-shot download token (it can be large).
 */
function wpdock_list_files(): void
{
  $input = json_decode(file_get_contents('php://input'), true);
  if (! is_array($input)) {
    $input = array();
  }

  $subtree = isset($input['subtree']) ? (string) $input['subtree'] : 'uploads';
  $subtree = str_replace('\\', '/', $subtree);
  $subtree = trim($subtree, '/');
  if (strpos($subtree, 'wp-content/') === 0) {
    $subtree = substr($subtree, strlen('wp-content/'));
  }
  if ($subtree === '' || strpos($subtree, '..') !== false || strpbrk($subtree, "\t\n") !== false) {
    wpdock_json_error('Invalid subtree', 400);
  }

  wpdock_ensure_temp_dir();
  $id            = bin2hex(random_bytes(8));
  $manifest_file = WPDOCK_TEMP_DIR . '/list-' . $id . '.manifest';
  $fh = fopen($manifest_file, 'w');
  if ($fh === false) {
    wpdock_json_error('Cannot create list manifest', 500);
  }

  $wp_content = WP_CONTENT_DIR;
  $base_dir   = $wp_content . '/' . $subtree;
  $total = 0;
  $bytes = 0;
  if (is_dir($base_dir)) {
    $files = new RecursiveIteratorIterator(
      new RecursiveDirectoryIterator($base_dir, RecursiveDirectoryIterator::SKIP_DOTS),
      RecursiveIteratorIterator::SELF_FIRST
    );
    foreach ($files as $file) {
      if ($file->isDir()) {
        continue;
      }
      $real_path = $file->getRealPath();
      if ($real_path === false) {
        continue;
      }
      // rel is relative to wp-content (the URL base), e.g. "uploads/2024/01/img.jpg".
      $rel = ltrim(str_replace($wp_content, '', $real_path), DIRECTORY_SEPARATOR);
      $rel = str_replace('\\', '/', $rel);
      if (strpbrk($rel, "\t\n") !== false) {
        continue;
      }
      $size = (int) $file->getSize();
      fwrite($fh, $rel . "\t" . $size . "\n");
      $total++;
      $bytes += $size;
    }
  }
  fclose($fh);

  $token = wpdock_store_temp_file($manifest_file);
  error_log('[WPDock] list_files subtree=' . $subtree . ' total=' . $total . ' bytes=' . $bytes);
  wpdock_json_success(array(
    'token'            => $token,
    'total'            => $total,
    'bytes'            => $bytes,
    'content_base_url' => content_url(),
  ));
}

function wpdock_pack_files_continue(string $id, int $shard = -1, bool $seq_dl = false): void
{
  $is_shard = ($shard >= 0);
  // Bounds keep a single request well under any host execution cap. Larger
  // batches mean far fewer round-trips (each one re-bootstraps all of WordPress
  // via the `init` hook — the dominant fixed cost on heavy production sites),
  // while 20s stays comfortably below typical PHP-FPM request_terminate_timeout
  // (~300s) even on modest hosts.
  $MAX_FILES   = 1500;
  $MAX_BYTES   = 48 * 1024 * 1024;
  $TIME_BUDGET = 20.0;
  // Already-compressed media: storing (no deflate) makes packing I/O-bound.
  $store_ext = array(
    'jpg' => 1, 'jpeg' => 1, 'png' => 1, 'gif' => 1, 'webp' => 1, 'avif' => 1, 'bmp' => 1, 'ico' => 1,
    'mp4' => 1, 'mov' => 1, 'webm' => 1, 'mkv' => 1, 'avi' => 1, 'mp3' => 1, 'ogg' => 1, 'm4a' => 1,
    'zip' => 1, 'gz' => 1, 'tgz' => 1, 'bz2' => 1, 'xz' => 1, '7z' => 1, 'rar' => 1,
    'pdf' => 1, 'woff' => 1, 'woff2' => 1,
  );

  // A shard reads its own cursor file + names its parts with a shard suffix so
  // concurrent shards never collide; the non-sharded path keeps the old names.
  $part_prefix = $is_shard ? ('pack-' . $id . '-s' . $shard) : ('pack-' . $id);
  $job_file    = WPDOCK_TEMP_DIR . '/' . $part_prefix . '.job';
  if (! file_exists($job_file)) {
    wpdock_json_error('Pack job not found or expired', 404);
  }

  // Serialize concurrent CONTINUE requests for the same job: two overlapping
  // requests must not both open the ZIP (append) or race the job-state file.
  // The lock auto-releases on script end (both JSON responders exit()).
  $lock_fp = fopen($job_file . '.lock', 'c');
  if ($lock_fp) {
    @flock($lock_fp, LOCK_EX);
  }

  $job = wpdock_read_json_array($job_file);
  if (! is_array($job)) {
    wpdock_json_error('Pack job state corrupted', 500);
  }

  $manifest_file = (string) ($job['manifest'] ?? '');
  $total         = (int) ($job['total'] ?? 0);
  // Slice bounds: a shard packs only [start,end); the legacy job uses [0,total).
  $start         = (int) ($job['start'] ?? 0);
  $end           = (int) ($job['end'] ?? $total);
  $index         = (int) ($job['index'] ?? 0);
  $offset        = (int) ($job['offset'] ?? 0);
  $part_seq      = (int) ($job['parts'] ?? 0);

  if (! file_exists($manifest_file)) {
    wpdock_json_error('Pack manifest missing', 500);
  }

  $part_token = null;
  $part_size  = 0;
  $made_part  = false;

  if ($index < $end) {
    // Each batch is packed into its OWN fresh ZIP part. We never re-open a
    // growing archive (ZipArchive::open(CREATE) rewrites the whole file on
    // close — O(total) per batch, O(n²) overall — which stalled huge sites).
    $part_file = WPDOCK_TEMP_DIR . '/' . $part_prefix . '-p' . $part_seq . '.zip';
    $zip = new ZipArchive();
    if ($zip->open($part_file, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
      wpdock_json_error('Cannot open pack ZIP', 500);
    }

    // O(1) resume by byte offset: SplFileObject::seek($index) re-reads the
    // manifest from line 0 every batch (another O(n²) cost on big sites).
    $fh = fopen($manifest_file, 'r');
    if ($fh === false) {
      @$zip->close();
      wpdock_json_error('Cannot read pack manifest', 500);
    }
    if ($offset > 0) {
      fseek($fh, $offset);
    }

    $start_time  = microtime(true);
    $batch_files = 0;
    $batch_bytes = 0;

    while ($index < $end && ($line = fgets($fh)) !== false) {
      $offset = ftell($fh);
      $index++;
      $line = rtrim($line, "\n");
      if ($line === '') {
        continue;
      }
      $parts = explode("\t", $line, 4);
      if (count($parts) < 4) {
        continue;
      }
      list($type, $size, $real_path, $rel_path) = $parts;

      if ($type === 'D') {
        $zip->addEmptyDir($rel_path);
      } else {
        if ($zip->addFile($real_path, $rel_path)) {
          $ext = strtolower(pathinfo($rel_path, PATHINFO_EXTENSION));
          if (isset($store_ext[$ext]) && method_exists($zip, 'setCompressionName')) {
            @$zip->setCompressionName($rel_path, ZipArchive::CM_STORE);
          }
        }
        $batch_bytes += (int) $size;
      }

      $batch_files++;
      if ($batch_files >= $MAX_FILES || $batch_bytes >= $MAX_BYTES || (microtime(true) - $start_time) >= $TIME_BUDGET) {
        break;
      }
    }
    // close() is where queued files are actually read + written; bounded by the
    // per-batch caps above (one small part) so it stays short.
    $zip->close();
    fclose($fh);

    // Manifest exhausted before reaching the slice end (no progress this batch):
    // finalize so the client's poll loop can't spin forever.
    if ($batch_files === 0 && $index < $end) {
      $index = $end;
    }

    if ($batch_files > 0 && file_exists($part_file) && filesize($part_file) > 0) {
      $part_size = (int) filesize($part_file);
      // Resumable clients fetch this part by seq (get_part) and ack_part to
      // delete it — no token needed. Old clients get a token for `download`.
      if (! $seq_dl) {
        $part_token = wpdock_store_temp_file($part_file);
      }
      $made_part = true;
      $part_seq++;
    } else {
      @unlink($part_file);
    }

    $job['index']  = $index;
    $job['offset'] = $offset;
    $job['parts']  = $part_seq;
    $job['bytes']  = (int) ($job['bytes'] ?? 0) + $batch_bytes;
    wpdock_write_json_atomic($job_file, $job);
  }

  $done = ($index >= $end);
  if ($done) {
    // Keep the small job file (marked done) so a stalled resumable client can
    // still read pack_status and drain any parts it missed by seq; the cron
    // sweep removes it (and any un-acked parts) after 6h. We only drop the big
    // manifest here, which packing no longer needs.
    $job['done'] = true;
    wpdock_write_json_atomic($job_file, $job);
    @unlink($job_file . '.lock');
    if ($is_shard) {
      // Drop the shared manifest + unused main job only once every shard slice
      // has reached done (job files are kept, so check the done flag, not glob
      // emptiness).
      $all_done = true;
      foreach (glob(WPDOCK_TEMP_DIR . '/pack-' . $id . '-s*.job') as $sib) {
        $sj = wpdock_read_json_array($sib);
        if (! is_array($sj) || empty($sj['done'])) {
          $all_done = false;
          break;
        }
      }
      if ($all_done) {
        @unlink($manifest_file);
        @unlink(WPDOCK_TEMP_DIR . '/pack-' . $id . '.job');
      }
    } else {
      @unlink($manifest_file);
    }
    error_log('[WPDock] pack_files DONE job=' . $id . ' shard=' . $shard . ' parts=' . $part_seq);
  }

  // Report progress within this slice; the client sums shards against the global
  // total it got from START. For the legacy path start=0/end=total → unchanged.
  $resp = array(
    'done'      => $done,
    'processed' => $index - $start,
    'total'     => $end - $start,
    // Total parts created so far (agent ≥1.3.7). After a stall the resumable
    // client drains [next_expected .. parts-1] via get_part before resuming.
    'parts'     => $part_seq,
  );
  if ($made_part) {
    // Seq of the part just created — its file is pack-<id>[-s<shard>]-p<seq>.zip.
    $resp['part_seq']  = $part_seq - 1;
    $resp['part_size'] = $part_size;
    if ($part_token !== null) {
      $resp['part_token'] = $part_token; // old clients download by token
    }
  }
  wpdock_json_success($resp);
}

/**
 * Resumable pack support (agent ≥1.3.7). A pack job persists its cursor
 * (index/offset/parts) atomically after every batch, so the job itself is
 * already resumable; the gap was the client: a stalled CONTINUE used to restart
 * the whole pack from line 0. These three actions let a stalled client recover
 * in place instead — it reads how far the cursor advanced (pack_status), pulls
 * any parts it missed by sequence (get_part, which — unlike token `download` —
 * does NOT delete), and frees server disk as it goes (ack_part). Parts are
 * addressed deterministically by job_id[+shard]+seq, so a part created but never
 * delivered (response lost on the stall) is still re-fetchable.
 */

/** Read-only pack cursor: how far the server advanced + how many parts exist. */
function wpdock_pack_status(): void
{
  $input = json_decode(file_get_contents('php://input'), true);
  if (! is_array($input)) {
    $input = array();
  }
  $id    = isset($input['job_id']) ? preg_replace('/[^a-f0-9]/i', '', (string) $input['job_id']) : '';
  $shard = isset($input['shard']) ? (int) $input['shard'] : -1;
  if ($id === '') {
    wpdock_json_error('Missing job_id', 400);
  }
  $prefix   = ($shard >= 0) ? ('pack-' . $id . '-s' . $shard) : ('pack-' . $id);
  $job_file = WPDOCK_TEMP_DIR . '/' . $prefix . '.job';
  if (! file_exists($job_file)) {
    wpdock_json_error('Pack job not found or expired', 404);
  }
  $job = wpdock_read_json_array($job_file);
  if (! is_array($job)) {
    wpdock_json_error('Pack job state corrupted', 500);
  }
  $total = (int) ($job['total'] ?? 0);
  $start = (int) ($job['start'] ?? 0);
  $end   = (int) ($job['end'] ?? $total);
  $index = (int) ($job['index'] ?? 0);
  wpdock_json_success(array(
    'parts'     => (int) ($job['parts'] ?? 0),
    'index'     => $index,
    'start'     => $start,
    'end'       => $end,
    'total'     => $total,
    'processed' => $index - $start,
    'done'      => ! empty($job['done']) || $index >= $end,
  ));
}

/** Stream an already-packed ZIP part by sequence WITHOUT deleting it. */
function wpdock_get_part(): void
{
  @set_time_limit(0);
  @ignore_user_abort(true);
  $id    = isset($_GET['job_id']) ? preg_replace('/[^a-f0-9]/i', '', (string) $_GET['job_id']) : '';
  $seq   = isset($_GET['seq']) ? (int) $_GET['seq'] : -1;
  $shard = isset($_GET['shard']) ? (int) $_GET['shard'] : -1;
  if ($id === '' || $seq < 0) {
    wpdock_json_error('Missing job_id/seq', 400);
  }
  $prefix    = ($shard >= 0) ? ('pack-' . $id . '-s' . $shard) : ('pack-' . $id);
  $part_file = WPDOCK_TEMP_DIR . '/' . $prefix . '-p' . $seq . '.zip';
  if (! file_exists($part_file)) {
    wpdock_json_error('Pack part not found', 404);
  }
  header('Content-Type: application/zip');
  header('Content-Length: ' . filesize($part_file));
  header('Content-Disposition: attachment; filename="' . basename($part_file) . '"');
  while (ob_get_level() > 0) {
    @ob_end_clean();
  }
  readfile($part_file);
  exit;
}

/** Confirm a part was extracted so the server can delete it (bounds disk). */
function wpdock_ack_part(): void
{
  $input = json_decode(file_get_contents('php://input'), true);
  if (! is_array($input)) {
    $input = array();
  }
  $id    = isset($input['job_id']) ? preg_replace('/[^a-f0-9]/i', '', (string) $input['job_id']) : '';
  $seq   = isset($input['seq']) ? (int) $input['seq'] : -1;
  $shard = isset($input['shard']) ? (int) $input['shard'] : -1;
  if ($id === '' || $seq < 0) {
    wpdock_json_error('Missing job_id/seq', 400);
  }
  $prefix    = ($shard >= 0) ? ('pack-' . $id . '-s' . $shard) : ('pack-' . $id);
  $part_file = WPDOCK_TEMP_DIR . '/' . $prefix . '-p' . $seq . '.zip';
  @unlink($part_file); // idempotent: deleting an already-acked part is fine
  wpdock_json_success(array('acked' => $seq));
}

function wpdock_export_db(): void
{
  wpdock_ensure_temp_dir();
  $sql_file = WPDOCK_TEMP_DIR . '/db-' . time() . '.sql';
  $err_file = WPDOCK_TEMP_DIR . '/db-' . time() . '.err.log';
  $dump_method = 'mysqldump';

  $db_host = DB_HOST;
  $db_user = DB_USER;
  $db_pass = DB_PASSWORD;
  $db_name = DB_NAME;

  error_log('[WPDock] export_db START db=' . $db_name . ' host=' . $db_host . ' user=' . $db_user);

  $host = $db_host;
  $port = '';
  if (strpos($host, ':') !== false) {
    $parts = explode(':', $host, 2);
    $host = $parts[0];
    $port = $parts[1] ?? '';
  }

  $cmd_parts = array(
    'mysqldump',
    '--single-transaction',
    '--quick',
    '--triggers',
    '--routines',
    '--events',
    '--skip-lock-tables',
    '--default-character-set=utf8mb4',
    '--host=' . escapeshellarg($host),
    '--user=' . escapeshellarg($db_user),
    '--password=' . escapeshellarg($db_pass),
  );

  if ($port !== '' && ctype_digit((string) $port)) {
    $cmd_parts[] = '--port=' . escapeshellarg($port);
  }

  $cmd_parts[] = escapeshellarg($db_name);

  $cmd = implode(' ', $cmd_parts) . ' > ' . escapeshellarg($sql_file) . ' 2> ' . escapeshellarg($err_file);

  $output = array();
  $exit_code = 1;
  error_log('[WPDock] export_db running mysqldump cmd_preview=' . substr($cmd, 0, 200));
  exec($cmd, $output, $exit_code);

  $dump_valid = ($exit_code === 0) && file_exists($sql_file) && filesize($sql_file) > 128;
  $err_content = (file_exists($err_file) && filesize($err_file) > 0) ? trim(file_get_contents($err_file)) : '';

  error_log('[WPDock] export_db mysqldump exit_code=' . $exit_code . ' dump_valid=' . ($dump_valid ? 'yes' : 'no') .
    ' file_size=' . (file_exists($sql_file) ? filesize($sql_file) : 0) .
    ($err_content !== '' ? ' stderr=' . substr($err_content, 0, 300) : ''));

  if (! $dump_valid) {
    // Fallback: PHP-based dump
    error_log('[WPDock] export_db mysqldump failed, using PHP fallback dump');
    $dump_method = 'php';
    wpdock_php_dump_db($sql_file);
    error_log('[WPDock] export_db php_dump done file_size=' . (file_exists($sql_file) ? filesize($sql_file) : 0));
  }

  if (! file_exists($sql_file) || filesize($sql_file) <= 128) {
    error_log('[WPDock] export_db ERROR: dump empty or missing path=' . $sql_file);
    wpdock_json_error('DB export produced an empty or invalid SQL dump', 500);
  }

  if (file_exists($err_file)) {
    @unlink($err_file);
  }

  $token = wpdock_store_temp_file($sql_file);
  $stats = wpdock_collect_db_stats();
  $table_count = count((array) ($stats['tables'] ?? array()));
  $total_rows  = array_sum((array) ($stats['tables'] ?? array()));
  error_log('[WPDock] export_db SUCCESS method=' . $dump_method .
    ' file_size=' . filesize($sql_file) .
    ' tables=' . $table_count .
    ' total_rows=' . $total_rows .
    ' table_list=' . implode(',', array_keys((array) ($stats['tables'] ?? array()))));
  wpdock_json_success(array(
    'file_token'  => $token,
    'file_size'   => (int) filesize($sql_file),
    'dump_method' => $dump_method,
    'db_stats'    => $stats,
  ));
}

function wpdock_collect_db_stats(): array
{
  global $wpdb;

  $prefix = (string) ($wpdb->prefix ?? 'wp_');
  $like = $wpdb->esc_like($prefix) . '%';
  $tables = $wpdb->get_col($wpdb->prepare('SHOW TABLES LIKE %s', $like));
  $counts = array();

  foreach ((array) $tables as $table) {
    $table = (string) $table;
    // Hard guard to avoid injecting unsafe identifiers.
    if (! preg_match('/^[a-zA-Z0-9_]+$/', $table)) {
      continue;
    }

    $value = $wpdb->get_var("SELECT COUNT(*) FROM `{$table}`");
    if ($value === null) {
      continue;
    }

    $counts[$table] = (int) $value;
  }

  return array(
    'prefix' => $prefix,
    'tables' => $counts,
  );
}

function wpdock_php_dump_db(string $output_file): void
{
  global $wpdb;

  $tables = $wpdb->get_col('SHOW TABLES');
  error_log('[WPDock] php_dump_db START table_count=' . count((array) $tables) . ' tables=' . implode(',', (array) $tables));
  $sql    = "SET FOREIGN_KEY_CHECKS=0;\n\n";

  foreach ($tables as $table) {
    // Structure
    $create = $wpdb->get_row("SHOW CREATE TABLE `{$table}`", ARRAY_N);
    $sql   .= "DROP TABLE IF EXISTS `{$table}`;\n";
    $sql   .= $create[1] . ";\n\n";

    // Data (chunked)
    $offset = 0;
    $limit  = 500;
    do {
      $rows = $wpdb->get_results("SELECT * FROM `{$table}` LIMIT {$limit} OFFSET {$offset}", ARRAY_N);
      if (empty($rows)) break;

      $cols = $wpdb->get_col_info('name');
      foreach ($rows as $row) {
        $values = array_map(function ($val) use ($wpdb) {
          if (is_null($val)) {
            return 'NULL';
          }
          return "'" . wpdock_escape_sql_literal((string) $val) . "'";
        }, $row);
        $sql .= "INSERT INTO `{$table}` VALUES (" . implode(', ', $values) . ");\n";
      }
      $offset += $limit;
    } while (count($rows) === $limit);

    $sql .= "\n";
  }

  $sql .= "SET FOREIGN_KEY_CHECKS=1;\n";
  $written = file_put_contents($output_file, $sql);
  error_log('[WPDock] php_dump_db DONE file_size=' . $written . ' tables_dumped=' . count((array) $tables));
}

function wpdock_escape_sql_literal(string $value): string
{
  return strtr($value, array(
    "\\" => "\\\\",
    "\0" => "\\0",
    "\n" => "\\n",
    "\r" => "\\r",
    "\x1a" => "\\Z",
    "'" => "\\'",
    '"' => '\\"',
  ));
}

function wpdock_handle_upload(): void
{
  if (empty($_FILES['file']) || $_FILES['file']['error'] !== UPLOAD_ERR_OK) {
    wpdock_json_error('Upload failed or no file provided', 400);
  }

  wpdock_ensure_temp_dir();

  $ext      = strtolower(pathinfo($_FILES['file']['name'], PATHINFO_EXTENSION));
  $allowed  = array('zip', 'sql');
  if (! in_array($ext, $allowed, true)) {
    wpdock_json_error('Invalid file type', 400);
  }

  $dest = WPDOCK_TEMP_DIR . '/upload-' . time() . '.' . $ext;
  move_uploaded_file($_FILES['file']['tmp_name'], $dest);

  $token = wpdock_store_temp_file($dest);
  wpdock_json_success(array('file_token' => $token));
}

function wpdock_upload_init(): void
{
  $body = json_decode(file_get_contents('php://input'), true);
  if (! is_array($body)) {
    wpdock_json_error('Invalid upload init payload', 400);
  }

  $filename = sanitize_file_name((string) ($body['filename'] ?? 'upload.bin'));
  $total_chunks = (int) ($body['total_chunks'] ?? 0);
  $ext = strtolower(pathinfo($filename, PATHINFO_EXTENSION));

  if ($total_chunks <= 0) {
    wpdock_json_error('Invalid total_chunks', 400);
  }

  if (! in_array($ext, array('zip', 'sql'), true)) {
    wpdock_json_error('Invalid file type for chunk upload', 400);
  }

  wpdock_ensure_temp_dir();

  $upload_id = bin2hex(random_bytes(16));
  $chunk_dir = WPDOCK_TEMP_DIR . '/chunks-' . $upload_id;
  if (! wp_mkdir_p($chunk_dir)) {
    wpdock_json_error('Cannot create chunk directory', 500);
  }

  $sessions = get_option('wpdock_upload_sessions', array());
  $sessions[$upload_id] = array(
    'dir' => $chunk_dir,
    'filename' => $filename,
    'total_chunks' => $total_chunks,
    'received' => array(),
    'expires' => time() + (2 * HOUR_IN_SECONDS),
  );
  update_option('wpdock_upload_sessions', $sessions, false);

  wpdock_json_success(array(
    'upload_id' => $upload_id,
    'total_chunks' => $total_chunks,
  ));
}

function wpdock_upload_chunk(): void
{
  $upload_id = sanitize_text_field((string) ($_POST['upload_id'] ?? ''));
  $chunk_index = isset($_POST['chunk_index']) ? (int) $_POST['chunk_index'] : -1;

  if ($upload_id === '' || $chunk_index < 0) {
    wpdock_json_error('Invalid chunk metadata', 400);
  }

  $sessions = get_option('wpdock_upload_sessions', array());
  if (! isset($sessions[$upload_id])) {
    wpdock_json_error('Upload session not found or expired', 404);
  }

  $session = $sessions[$upload_id];
  if (($session['expires'] ?? 0) < time()) {
    wpdock_delete_upload_session($upload_id, $sessions, true);
    wpdock_json_error('Upload session expired', 410);
  }

  if (empty($_FILES['chunk']) || $_FILES['chunk']['error'] !== UPLOAD_ERR_OK) {
    wpdock_json_error('Chunk upload failed', 400);
  }

  $chunk_dir = (string) ($session['dir'] ?? '');
  if ($chunk_dir === '' || ! is_dir($chunk_dir)) {
    wpdock_json_error('Upload session storage missing', 500);
  }

  $chunk_path = $chunk_dir . '/chunk-' . str_pad((string) $chunk_index, 6, '0', STR_PAD_LEFT) . '.part';
  if (! move_uploaded_file($_FILES['chunk']['tmp_name'], $chunk_path)) {
    wpdock_json_error('Cannot store uploaded chunk', 500);
  }

  if (! isset($session['received']) || ! is_array($session['received'])) {
    $session['received'] = array();
  }
  $session['received'][(string) $chunk_index] = 1;
  $sessions[$upload_id] = $session;
  update_option('wpdock_upload_sessions', $sessions, false);

  $received_count = count($session['received']);
  $total_chunks = (int) ($session['total_chunks'] ?? 0);

  wpdock_json_success(array(
    'upload_id' => $upload_id,
    'received_chunks' => $received_count,
    'total_chunks' => $total_chunks,
  ));
}

function wpdock_upload_finalize(): void
{
  $body = json_decode(file_get_contents('php://input'), true);
  if (! is_array($body)) {
    wpdock_json_error('Invalid upload finalize payload', 400);
  }

  $upload_id = sanitize_text_field((string) ($body['upload_id'] ?? ''));
  if ($upload_id === '') {
    wpdock_json_error('upload_id is required', 400);
  }

  $sessions = get_option('wpdock_upload_sessions', array());
  if (! isset($sessions[$upload_id])) {
    wpdock_json_error('Upload session not found or expired', 404);
  }

  $session = $sessions[$upload_id];
  if (($session['expires'] ?? 0) < time()) {
    wpdock_delete_upload_session($upload_id, $sessions, true);
    wpdock_json_error('Upload session expired', 410);
  }

  $chunk_dir = (string) ($session['dir'] ?? '');
  $filename = sanitize_file_name((string) ($session['filename'] ?? 'upload.bin'));
  $total_chunks = (int) ($session['total_chunks'] ?? 0);
  if ($chunk_dir === '' || ! is_dir($chunk_dir) || $total_chunks <= 0) {
    wpdock_json_error('Upload session is invalid', 500);
  }

  $ext = strtolower(pathinfo($filename, PATHINFO_EXTENSION));
  $dest = WPDOCK_TEMP_DIR . '/upload-' . time() . '-' . wp_generate_password(6, false, false) . '.' . $ext;
  $out = fopen($dest, 'wb');
  if (! $out) {
    wpdock_json_error('Cannot create destination file', 500);
  }

  for ($i = 0; $i < $total_chunks; $i++) {
    $chunk_path = $chunk_dir . '/chunk-' . str_pad((string) $i, 6, '0', STR_PAD_LEFT) . '.part';
    if (! file_exists($chunk_path)) {
      fclose($out);
      @unlink($dest);
      wpdock_json_error('Missing chunk #' . $i, 409);
    }

    $in = fopen($chunk_path, 'rb');
    if (! $in) {
      fclose($out);
      @unlink($dest);
      wpdock_json_error('Cannot read chunk #' . $i, 500);
    }

    while (! feof($in)) {
      $buf = fread($in, 1048576);
      if ($buf === false) {
        fclose($in);
        fclose($out);
        @unlink($dest);
        wpdock_json_error('Failed to read chunk data', 500);
      }
      if ($buf !== '') {
        fwrite($out, $buf);
      }
    }
    fclose($in);
    @unlink($chunk_path);
  }

  fclose($out);
  @rmdir($chunk_dir);
  unset($sessions[$upload_id]);
  update_option('wpdock_upload_sessions', $sessions, false);

  $token = wpdock_store_temp_file($dest);
  wpdock_json_success(array(
    'file_token' => $token,
    'file_size' => file_exists($dest) ? (int) filesize($dest) : 0,
    'filename' => $filename,
  ));
}

/**
 * Recursively delete a directory and all its contents.
 * Returns true on success, false if anything could not be deleted.
 */
function wpdock_rmdir_recursive(string $dir): bool
{
  if (! is_dir($dir)) {
    return true;
  }
  $ok = true;
  $items = new RecursiveIteratorIterator(
    new RecursiveDirectoryIterator($dir, RecursiveDirectoryIterator::SKIP_DOTS),
    RecursiveIteratorIterator::CHILD_FIRST
  );
  foreach ($items as $item) {
    if ($item->isDir()) {
      $ok = @rmdir($item->getRealPath()) && $ok;
    } else {
      $ok = @unlink($item->getRealPath()) && $ok;
    }
  }
  $ok = @rmdir($dir) && $ok;
  return $ok;
}

function wpdock_extract_files(): void
{
  // Allow long-running extraction without PHP timeout / memory exhaustion.
  @set_time_limit(0);
  @ini_set('memory_limit', '512M');

  $body  = json_decode(file_get_contents('php://input'), true);
  $token = sanitize_text_field($body['file_token'] ?? '');
  $file  = wpdock_resolve_token($token);

  if (! $file || ! file_exists($file)) {
    wpdock_json_error('File not found', 404);
  }

  $zip = new ZipArchive();
  if ($zip->open($file) !== true) {
    wpdock_json_error('Cannot open ZIP file', 500);
  }

  // Protected paths — never overwrite the WPDock agent plugin itself.
  $protected_prefixes = array(
    'wp-content/plugins/wpdock-agent/',
    'wp-content/plugins/wpdock-agent.php',
  );

  // ── Strategy: extractTo() into a temp dir, then copy to ABSPATH ─────────
  // ZipArchive::getStream() is unreliable on shared hosts for compressed entries
  // (returns false for deflated files on some PHP builds).  Using extractTo()
  // + recursive copy is far more robust and handles all compression methods.
  $tmp_dir = WPDOCK_TEMP_DIR . '/extract-' . time() . '-' . wp_generate_password(8, false, false);
  wp_mkdir_p($tmp_dir);

  if (! $zip->extractTo($tmp_dir)) {
    $zip->close();
    wpdock_rmdir_recursive($tmp_dir);
    @unlink($file);
    wpdock_remove_token($token);
    wpdock_json_error('ZIP extractTo() failed — check disk space and permissions', 500);
  }

  $zip->close();
  @unlink($file);
  wpdock_remove_token($token);

  // ── Copy from temp dir to ABSPATH, skipping protected paths ─────────────
  $abspath   = rtrim(str_replace('\\', '/', ABSPATH), '/') . '/';
  $tmp_norm  = rtrim(str_replace('\\', '/', realpath($tmp_dir) ?: $tmp_dir), '/');

  $skipped   = 0;
  $extracted = 0;
  $failed    = 0;

  $iter = new RecursiveIteratorIterator(
    new RecursiveDirectoryIterator($tmp_dir, RecursiveDirectoryIterator::SKIP_DOTS),
    RecursiveIteratorIterator::SELF_FIRST
  );

  foreach ($iter as $item) {
    $real = str_replace('\\', '/', $item->getRealPath());
    $rel  = ltrim(substr($real, strlen($tmp_norm)), '/');

    // Check protected prefixes.
    $skip = false;
    foreach ($protected_prefixes as $prefix) {
      if (stripos($rel, $prefix) === 0) {
        $skip = true;
        break;
      }
    }
    if ($skip) {
      $skipped++;
      continue;
    }

    $dest = $abspath . $rel;

    if ($item->isDir()) {
      if (! is_dir($dest)) {
        wp_mkdir_p($dest);
      }
      continue;
    }

    $dir = dirname($dest);
    if (! is_dir($dir)) {
      wp_mkdir_p($dir);
    }

    if (copy($item->getRealPath(), $dest)) {
      $extracted++;
    } else {
      $failed++;
      error_log('[WPDock] extract_files COPY_FAIL rel=' . $rel . ' dest=' . $dest);
    }
  }

  wpdock_rmdir_recursive($tmp_dir);

  error_log(
    '[WPDock] extract_files done: extracted=' . $extracted .
      ' skipped=' . $skipped .
      ' failed=' . $failed
  );

  wpdock_json_success(array(
    'extracted'         => true,
    'files_extracted'   => $extracted,
    'skipped_protected' => $skipped,
    'failed'            => $failed,
  ));
}

function wpdock_import_db(): void
{
  $body                 = json_decode(file_get_contents('php://input'), true);
  $token                = sanitize_text_field($body['file_token'] ?? '');
  $target_url           = sanitize_text_field($body['target_url'] ?? '');
  // preserve_credentials: keep remote wp_users, wp_usermeta and auth keys/salts.
  // Defaults to TRUE so pushing dev DB to production never locks you out.
  $preserve_credentials = isset($body['preserve_credentials']) ? (bool) $body['preserve_credentials'] : true;
  $file                 = wpdock_resolve_token($token);

  if (! $file || ! file_exists($file)) {
    error_log('[WPDock] import_db ERROR: SQL file not found token=' . $token);
    wpdock_json_error('SQL file not found', 404);
  }

  global $wpdb;
  $sql_size = filesize($file);
  $sql      = file_get_contents($file);
  if ($sql === false || trim($sql) === '') {
    error_log('[WPDock] import_db ERROR: SQL dump is empty file=' . $file);
    wpdock_json_error('SQL dump is empty', 400);
  }

  // Detect the table prefix actually used inside the dump.
  // Strategy: collect every CREATE TABLE name, then match against the known list of
  // WP core table suffixes (ordered from most-distinctive to least).  The prefix is
  // whatever text precedes the matched suffix.  This handles any prefix format:
  //   wp_  /  wpve_  /  wp774_  /  wp_774_  /  wpsitename_  …
  $wp_known_suffixes = array(
    'options',
    'posts',
    'postmeta',
    'users',
    'usermeta',
    'term_relationships',
    'term_taxonomy',
    'termmeta',
    'terms',
    'commentmeta',
    'comments',
    'links',
  );

  preg_match_all(
    '/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`([^`]+)`/i',
    $sql,
    $tbl_matches
  );
  $dump_tables   = array_values(array_unique((array) ($tbl_matches[1] ?? array())));
  $source_prefix = 'wp_'; // safe fallback
  $prefix_found  = false;

  foreach ($dump_tables as $tbl) {
    $tbl_lower = strtolower((string) $tbl);
    foreach ($wp_known_suffixes as $suffix) {
      $slen = strlen($suffix);
      if (
        strlen($tbl_lower) > $slen &&
        substr($tbl_lower, -$slen) === $suffix
      ) {
        $candidate = substr($tbl, 0, strlen($tbl) - $slen);
        // Sanity check: prefix must not be empty and must contain only
        // alphanumeric chars and underscores (WordPress constraint).
        if ($candidate !== '' && preg_match('/^[a-z0-9_]+$/i', $candidate)) {
          $source_prefix = $candidate;
          $prefix_found  = true;
          break 2;
        }
      }
    }
  }

  error_log(
    '[WPDock] import_db prefix detection: found=' . ($prefix_found ? 'yes' : 'no(fallback)') .
      ' source_prefix=' . $source_prefix .
      ' dump_tables=' . count($dump_tables)
  );

  $remote_prefix = (string) ($wpdb->prefix ?? 'wp_');

  // If the dump prefix differs from the remote prefix, rewrite all backtick-quoted
  // table names in the SQL so CREATE/INSERT/DROP all target the correct prefix.
  if ($source_prefix !== $remote_prefix) {
    error_log(
      '[WPDock] import_db prefix mismatch: dump=' . $source_prefix .
        ' remote=' . $remote_prefix . ' — rewriting SQL table names'
    );
    $sql = str_replace('`' . $source_prefix, '`' . $remote_prefix, $sql);
  }

  // ── Snapshot remote credentials (before wipe) ────────────────────────────
  // When preserve_credentials=true we capture wp_users, wp_usermeta and the
  // WP secret keys/salts from wp_options BEFORE the full DB wipe.  After the
  // import these rows are restored so the remote admin password, user accounts
  // and active sessions are untouched.
  $saved_users          = array();
  $saved_usermeta       = array();
  $saved_auth_options   = array();
  $saved_active_plugins = null;  // serialized option_value string
  $saved_agent_token    = null;  // wpdock_agent_token transient value

  if ($preserve_credentials) {
    $users_tbl    = $remote_prefix . 'users';
    $usermeta_tbl = $remote_prefix . 'usermeta';
    $options_tbl  = $remote_prefix . 'options';

    // Check that the tables actually exist before trying to read from them.
    $existing_tables = $wpdb->get_col('SHOW TABLES');
    $has_users       = in_array($users_tbl, (array) $existing_tables, true);
    $has_usermeta    = in_array($usermeta_tbl, (array) $existing_tables, true);
    $has_options     = in_array($options_tbl, (array) $existing_tables, true);

    if ($has_users) {
      $saved_users = (array) $wpdb->get_results(
        "SELECT * FROM `{$users_tbl}`", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
        ARRAY_A
      );
    }
    if ($has_usermeta && ! empty($saved_users)) {
      $user_ids        = array_map('intval', array_column($saved_users, 'ID'));
      $ids_placeholder = implode(',', $user_ids);
      $saved_usermeta  = (array) $wpdb->get_results(
        "SELECT * FROM `{$usermeta_tbl}` WHERE user_id IN ({$ids_placeholder})", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
        ARRAY_A
      );
    }
    if ($has_options) {
      $auth_names  = array(
        'auth_key',
        'secure_auth_key',
        'logged_in_key',
        'nonce_key',
        'auth_salt',
        'secure_auth_salt',
        'logged_in_salt',
        'nonce_salt'
      );
      $names_sql   = "'" . implode("','", $auth_names) . "'";
      $saved_auth_options = (array) $wpdb->get_results(
        "SELECT option_name, option_value FROM `{$options_tbl}` WHERE option_name IN ({$names_sql})", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
        ARRAY_A
      );

      // Save active_plugins so we can ensure wpdock-agent stays active after import.
      $ap_row = $wpdb->get_row( // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
        $wpdb->prepare(
          "SELECT option_value FROM `{$options_tbl}` WHERE option_name = %s", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
          'active_plugins'
        )
      );
      if ($ap_row) {
        $saved_active_plugins = $ap_row->option_value;
      }

      // Save wpdock agent token transient so the session stays valid after DB wipe.
      $token_row = $wpdb->get_row( // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
        $wpdb->prepare(
          "SELECT option_value FROM `{$options_tbl}` WHERE option_name = %s", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
          '_transient_wpdock_agent_token'
        )
      );
      if ($token_row) {
        $saved_agent_token = $token_row->option_value;
      }
    }

    error_log(
      '[WPDock] import_db snapshot: users=' . count($saved_users) .
        ' usermeta=' . count($saved_usermeta) .
        ' auth_options=' . count($saved_auth_options) .
        ' active_plugins_saved=' . ($saved_active_plugins !== null ? 'yes' : 'no') .
        ' agent_token_saved=' . ($saved_agent_token !== null ? 'yes' : 'no')
    );
  }
  // ─────────────────────────────────────────────────────────────────────────

  // ── Full DB wipe before import ───────────────────────────────────────────
  // Drop EVERY table in the database so the import is a clean slate regardless
  // of what prefix or extra tables existed before.
  $all_tables = $wpdb->get_col('SHOW TABLES');
  $dropped    = 0;
  if (! empty($all_tables)) {
    // Disable FK checks so tables with foreign-key dependencies can be dropped.
    $wpdb->query('SET FOREIGN_KEY_CHECKS = 0');
    foreach ($all_tables as $tbl) {
      $tbl_escaped = '`' . esc_sql((string) $tbl) . '`';
      $wpdb->query("DROP TABLE IF EXISTS {$tbl_escaped}"); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
      $dropped++;
    }
    $wpdb->query('SET FOREIGN_KEY_CHECKS = 1');
    error_log('[WPDock] import_db wiped DB: dropped=' . $dropped . ' tables');
  }
  // ─────────────────────────────────────────────────────────────────────────

  // Count CREATE TABLE statements to know what to expect
  preg_match_all('/CREATE\s+TABLE/i', $sql, $ct_matches);
  $expected_tables = count($ct_matches[0]);
  $sql_preview     = substr(preg_replace('/\s+/', ' ', $sql), 0, 200);
  error_log('[WPDock] import_db START file_size=' . $sql_size .
    ' source_prefix=' . $source_prefix .
    ' remote_prefix=' . $remote_prefix .
    ' dropped_before=' . $dropped .
    ' expected_tables=' . $expected_tables .
    ' sql_preview=' . $sql_preview);

  $result = wpdock_import_sql($sql);

  @unlink($file);
  wpdock_remove_token($token);

  if (! ($result['success'] ?? false)) {
    error_log('[WPDock] import_db FAILED method=' . ($result['method'] ?? 'unknown') .
      ' error=' . ($result['error'] ?? 'unknown') .
      ' statements=' . ($result['statements'] ?? 0) .
      ' skipped=' . ($result['skipped'] ?? 0));
    wpdock_json_error((string) ($result['error'] ?? 'DB import failed'), 500);
  }

  $warnings = array_values(array_filter((array) ($result['warnings'] ?? array())));
  error_log('[WPDock] import_db SUCCESS method=' . ($result['method'] ?? 'unknown') .
    ' statements=' . ($result['statements'] ?? 0) .
    ' skipped=' . ($result['skipped'] ?? 0) .
    ' warnings=' . count($warnings) .
    (count($warnings) > 0 ? ' first_warning=' . $warnings[0] : ''));

  $options_table  = $remote_prefix . 'options';
  $usermeta_table = $remote_prefix . 'usermeta';

  // ── Fix prefix in wp_options.option_name and wp_usermeta.meta_key ────────
  // When the remote table prefix differs from the dump prefix, SQL table names
  // are already rewritten above.  But DATA values that contain the prefix
  // (e.g. option_name = "wp_user_roles", meta_key = "wp_capabilities") are NOT
  // touched by that rewrite — they must be updated separately.
  // We ALWAYS run this (even when prefixes are equal) to be safe, because it
  // is a no-op if the prefix hasn't changed.
  $prefix_rows_opt  = false;
  $prefix_rows_meta = false;
  if ($source_prefix !== $remote_prefix) {
    // Update option_name: e.g. "wp_user_roles" → "{remote_prefix}user_roles"
    $like_pattern         = $wpdb->esc_like($source_prefix) . '%';
    $prefix_rows_opt      = $wpdb->query(
      $wpdb->prepare(
        "UPDATE `{$options_table}` SET option_name = CONCAT(%s, SUBSTRING(option_name, %d)) WHERE option_name LIKE %s",
        $remote_prefix,
        strlen($source_prefix) + 1,
        $like_pattern
      )
    );
    // Update meta_key: e.g. "wp_capabilities", "wp_user_level" → remote equivalents
    $prefix_rows_meta = $wpdb->query(
      $wpdb->prepare(
        "UPDATE `{$usermeta_table}` SET meta_key = CONCAT(%s, SUBSTRING(meta_key, %d)) WHERE meta_key LIKE %s",
        $remote_prefix,
        strlen($source_prefix) + 1,
        $like_pattern
      )
    );
    error_log(
      '[WPDock] import_db prefix data fix: options_rows=' . (int) $prefix_rows_opt .
        ' usermeta_rows=' . (int) $prefix_rows_meta .
        ' source_prefix=' . $source_prefix .
        ' remote_prefix=' . $remote_prefix
    );
  }
  // ─────────────────────────────────────────────────────────────────────────

  // Fix siteurl / home so the remote site is immediately reachable at its own URL.
  $url_updated = false;
  if (! empty($target_url)) {
    $rows_s = $wpdb->update(
      $options_table,
      array('option_value' => $target_url),
      array('option_name'  => 'siteurl')
    );
    $rows_h = $wpdb->update(
      $options_table,
      array('option_value' => $target_url),
      array('option_name'  => 'home')
    );
    $url_updated = ($rows_s !== false || $rows_h !== false);
    error_log(
      '[WPDock] import_db siteurl/home updated table=' . $options_table .
        ' target=' . $target_url .
        ' rows_siteurl=' . (int) $rows_s .
        ' rows_home=' . (int) $rows_h
    );
  }

  // ── Restore remote credentials (after import + URL fix) ─────────────────
  $credentials_restored = false;
  if ($preserve_credentials && (! empty($saved_users) || ! empty($saved_auth_options))) {
    $users_tbl    = $remote_prefix . 'users';
    $usermeta_tbl = $remote_prefix . 'usermeta';
    $options_tbl  = $remote_prefix . 'options';

    // Restore wp_users rows (REPLACE handles both INSERT and UPDATE by primary key).
    foreach ($saved_users as $row) {
      $wpdb->replace($users_tbl, $row);
    }

    // Restore wp_usermeta rows.  Rewrite any meta_key that carries the OLD
    // source prefix so it matches the remote prefix after rewriting above.
    foreach ($saved_usermeta as $meta_row) {
      if (
        $source_prefix !== $remote_prefix &&
        strpos((string) $meta_row['meta_key'], $source_prefix) === 0
      ) {
        $meta_row['meta_key'] = $remote_prefix . substr((string) $meta_row['meta_key'], strlen($source_prefix));
      }
      $wpdb->replace($usermeta_tbl, $meta_row);
    }

    // Restore auth keys/salts.
    foreach ($saved_auth_options as $opt) {
      $wpdb->update(
        $options_tbl,
        array('option_value' => $opt['option_value']),
        array('option_name'  => $opt['option_name'])
      );
    }

    $credentials_restored = true;
    error_log(
      '[WPDock] import_db credentials restored: users=' . count($saved_users) .
        ' usermeta=' . count($saved_usermeta) .
        ' auth_options=' . count($saved_auth_options)
    );
  }
  // ─────────────────────────────────────────────────────────────────────────

  // ── Ensure wpdock-agent stays active after DB import ─────────────────────
  // When preserve_credentials is on, we merge the remote's saved active_plugins
  // with the imported list, always keeping wpdock-agent/wpdock-agent.php active.
  // This prevents the agent from being deactivated by the local DB dump which
  // does not know about remote-only plugins.
  $agent_basename  = 'wpdock-agent/wpdock-agent.php';
  $agent_opts_tbl  = $remote_prefix . 'options';

  $imported_ap_val = $wpdb->get_var( // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
    $wpdb->prepare(
      "SELECT option_value FROM `{$agent_opts_tbl}` WHERE option_name = %s", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
      'active_plugins'
    )
  );
  $imported_plugins = maybe_unserialize((string) $imported_ap_val);
  if (! is_array($imported_plugins)) {
    $imported_plugins = array();
  }

  // Start from the remote's original plugin list (if saved) so that remote-only
  // plugins are not silently deactivated.  Then merge in anything the local dump
  // added that wasn't already there.
  if ($preserve_credentials && ! empty($saved_active_plugins)) {
    $remote_plugins = maybe_unserialize((string) $saved_active_plugins);
    if (! is_array($remote_plugins)) {
      $remote_plugins = $imported_plugins;
    }
    // Add any plugins from the local dump that are not yet in the remote list.
    foreach ($imported_plugins as $p) {
      if (! in_array($p, $remote_plugins, true)) {
        $remote_plugins[] = $p;
      }
    }
  } else {
    $remote_plugins = $imported_plugins;
  }

  // Always ensure the agent itself is active.
  if (! in_array($agent_basename, $remote_plugins, true)) {
    $remote_plugins[] = $agent_basename;
  }

  sort($remote_plugins); // WordPress sorts active_plugins alphabetically.
  $wpdb->update(
    $agent_opts_tbl,
    array('option_value' => serialize($remote_plugins)),
    array('option_name'  => 'active_plugins')
  );
  error_log('[WPDock] import_db active_plugins fixed: total=' . count($remote_plugins) . ' agent_active=yes');
  // ─────────────────────────────────────────────────────────────────────────

  // ── Restore wpdock agent token transient ─────────────────────────────────
  // The DB wipe removes the token stored during ensureAgent().  We restore it
  // so that the current push session (and near-future pushes) continue to work
  // without requiring a full re-authentication cycle.
  if ($saved_agent_token !== null) {
    $wpdb->delete($agent_opts_tbl, array('option_name' => '_transient_wpdock_agent_token'));
    $wpdb->delete($agent_opts_tbl, array('option_name' => '_transient_timeout_wpdock_agent_token'));
    $wpdb->insert(
      $agent_opts_tbl,
      array(
        'option_name'  => '_transient_wpdock_agent_token',
        'option_value' => $saved_agent_token,
        'autoload'     => 'no',
      )
    );
    $wpdb->insert(
      $agent_opts_tbl,
      array(
        'option_name'  => '_transient_timeout_wpdock_agent_token',
        'option_value' => (string) (time() + DAY_IN_SECONDS * 30),
        'autoload'     => 'no',
      )
    );
    error_log('[WPDock] import_db agent token restored');
  }
  // ─────────────────────────────────────────────────────────────────────────

  // Verify tables were actually created
  $actual_tables = $wpdb->get_col('SHOW TABLES');
  error_log('[WPDock] import_db post-import table check: found=' . count((array) $actual_tables) .
    ' expected_creates=' . $expected_tables .
    ' table_list=' . implode(',', (array) $actual_tables));

  wpdock_json_success(array(
    'imported'              => true,
    'method'                => $result['method'] ?? 'unknown',
    'statements'            => (int) ($result['statements'] ?? 0),
    'skipped'               => (int) ($result['skipped'] ?? 0),
    'warnings'              => $warnings,
    'expected_tables'       => $expected_tables,
    'actual_tables'         => count((array) $actual_tables),
    'table_list'            => array_values((array) $actual_tables),
    'prefix_rewritten'      => ($source_prefix !== $remote_prefix),
    'prefix_data_fixed'     => ($prefix_rows_opt !== false || $prefix_rows_meta !== false),
    'url_updated'           => $url_updated,
    'credentials_preserved' => $credentials_restored,
  ));
}

function wpdock_import_sql(string $sql): array
{
  $mysqli_result = wpdock_import_db_via_mysqli($sql);
  if ($mysqli_result['success']) {
    return $mysqli_result;
  }

  $wpdb_result = wpdock_import_db_via_wpdb($sql);
  if ($wpdb_result['success']) {
    $warnings = array();
    if (! empty($mysqli_result['error'])) {
      $warnings[] = 'mysqli fallback: ' . $mysqli_result['error'];
    }
    $wpdb_result['warnings'] = $warnings;
    return $wpdb_result;
  }

  return array(
    'success' => false,
    'method' => 'failed',
    'error' => trim(
      'mysqli: ' . (string) ($mysqli_result['error'] ?? 'unknown') .
        ' | wpdb: ' . (string) ($wpdb_result['error'] ?? 'unknown')
    ),
  );
}

function wpdock_import_db_via_mysqli(string $sql): array
{
  if (! function_exists('mysqli_init')) {
    error_log('[WPDock] mysqli import SKIP: extension unavailable');
    return array(
      'success' => false,
      'method' => 'mysqli',
      'error' => 'mysqli extension is unavailable',
    );
  }

  $parsed = wpdock_parse_db_host(DB_HOST);
  error_log('[WPDock] mysqli import CONNECT host=' . ($parsed['host'] ?? '?') .
    ' port=' . ($parsed['port'] ?? 0) .
    ' user=' . DB_USER . ' db=' . DB_NAME .
    ' sql_len=' . strlen($sql));

  $mysqli = mysqli_init();
  if (! $mysqli) {
    error_log('[WPDock] mysqli import ERROR: mysqli_init() failed');
    return array(
      'success' => false,
      'method' => 'mysqli',
      'error' => 'Cannot initialize mysqli',
    );
  }

  mysqli_options($mysqli, MYSQLI_OPT_CONNECT_TIMEOUT, 30);
  $connected = @mysqli_real_connect(
    $mysqli,
    (string) ($parsed['host'] ?? '127.0.0.1'),
    DB_USER,
    DB_PASSWORD,
    DB_NAME,
    (int) ($parsed['port'] ?? 0),
    (string) ($parsed['socket'] ?? '')
  );

  if (! $connected) {
    $error = mysqli_connect_error() ?: 'Unknown mysqli connection error';
    error_log('[WPDock] mysqli import CONNECT FAILED error=' . $error);
    mysqli_close($mysqli);
    return array(
      'success' => false,
      'method' => 'mysqli',
      'error' => $error,
    );
  }
  error_log('[WPDock] mysqli import connected OK');

  @mysqli_set_charset($mysqli, 'utf8mb4');

  if (! @mysqli_multi_query($mysqli, $sql)) {
    $error = mysqli_error($mysqli) ?: 'Unknown mysqli import error';
    error_log('[WPDock] mysqli multi_query FAILED on start: ' . $error);
    mysqli_close($mysqli);
    return array(
      'success' => false,
      'method' => 'mysqli',
      'error' => $error,
    );
  }

  $statements = 0;
  $last_error = '';
  do {
    $statements++;
    $result = @mysqli_store_result($mysqli);
    if ($result instanceof mysqli_result) {
      mysqli_free_result($result);
    }
    $stmt_error = mysqli_error($mysqli);
    if ($stmt_error !== '') {
      error_log('[WPDock] mysqli stmt #' . $statements . ' error: ' . $stmt_error);
      $last_error = $stmt_error;
    }
  } while (@mysqli_more_results($mysqli) && @mysqli_next_result($mysqli));

  $error = $last_error ?: mysqli_error($mysqli);
  mysqli_close($mysqli);
  if ($error !== '') {
    error_log('[WPDock] mysqli import FAILED after ' . $statements . ' statements: ' . $error);
    return array(
      'success' => false,
      'method' => 'mysqli',
      'error' => $error,
      'statements' => $statements,
    );
  }

  error_log('[WPDock] mysqli import SUCCESS statements=' . $statements);
  return array(
    'success' => true,
    'method' => 'mysqli',
    'statements' => $statements,
  );
}

/**
 * Returns true for mysqldump service statements that are safe to skip on failure.
 * These are session-variable sets, lock/unlock statements, and conditional comments
 * that managed/shared MySQL hosts may reject but which don't affect actual data.
 */
function wpdock_is_skippable_sql(string $q): bool
{
  // Blank or pure SQL comment
  if ($q === '' || strncmp($q, '--', 2) === 0) {
    return true;
  }
  // MySQL conditional comments: /*!NNNNN ... */ with no real statement inside
  if (preg_match('/^\/\*![\s\S]*\*\/$/', $q)) {
    return true;
  }
  $upper = strtoupper(ltrim($q));
  // SET @OLD_... style mysqldump session-variable saves/restores
  if (strncmp($upper, 'SET @', 5) === 0) {
    return true;
  }
  // SET SESSION / SET GLOBAL / SET NAMES (charset)
  if (preg_match('/^SET\s+(SESSION|GLOBAL|NAMES)\s/i', $q)) {
    return true;
  }
  // LOCK TABLES / UNLOCK TABLES
  if (preg_match('/^(LOCK|UNLOCK)\s+TABLES/i', $q)) {
    return true;
  }
  return false;
}

function wpdock_import_db_via_wpdb(string $sql): array
{
  global $wpdb;

  error_log('[WPDock] wpdb import START sql_len=' . strlen($sql));

  // Split on ; followed by optional whitespace then newline-or-end
  $queries  = preg_split('/;[ \t]*(?:\r?\n|$)/', $sql) ?: array();
  $total_queries = count($queries);
  $statements = 0;
  $skipped    = 0;
  $warnings   = array();

  error_log('[WPDock] wpdb import query_count=' . $total_queries);

  foreach ($queries as $i => $query) {
    $query = trim((string) $query);
    if ($query === '' || strncmp($query, '--', 2) === 0) {
      continue;
    }

    $result = $wpdb->query($query); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
    if ($result === false) {
      $preview = substr(preg_replace('/\s+/', ' ', $query), 0, 180);
      if (wpdock_is_skippable_sql($query)) {
        // Non-critical mysqldump directive rejected by this host — skip.
        $skipped++;
        $w = 'skipped[' . $i . ']: ' . $preview;
        $warnings[] = $w;
        error_log('[WPDock] wpdb ' . $w);
        continue;
      }
      $err = $wpdb->last_error ?: 'wpdb query failed';
      error_log('[WPDock] wpdb import FATAL at query[' . $i . '] error=' . $err . ' query=' . $preview);
      return array(
        'success'    => false,
        'method'     => 'wpdb',
        'error'      => $err . ' near: ' . $preview,
        'statements' => $statements,
        'skipped'    => $skipped,
        'warnings'   => $warnings,
      );
    }

    $statements++;
    // Log every 100th statement so we can see progress
    if ($statements % 100 === 0) {
      error_log('[WPDock] wpdb import progress statements=' . $statements . ' skipped=' . $skipped);
    }
  }

  error_log('[WPDock] wpdb import SUCCESS statements=' . $statements . ' skipped=' . $skipped . ' warnings=' . count($warnings));
  return array(
    'success'    => true,
    'method'     => 'wpdb',
    'statements' => $statements,
    'skipped'    => $skipped,
    'warnings'   => $warnings,
  );
}

function wpdock_parse_db_host(string $db_host): array
{
  $host = trim($db_host);
  $port = 0;
  $socket = '';

  if (strpos($host, ':/') !== false) {
    $parts = explode(':', $host, 2);
    $host = $parts[0];
    $socket = $parts[1] ?? '';
  } elseif (substr_count($host, ':') === 1) {
    $parts = explode(':', $host, 2);
    if (ctype_digit((string) ($parts[1] ?? ''))) {
      $host = $parts[0];
      $port = (int) $parts[1];
    }
  }

  return array(
    'host' => $host !== '' ? $host : '127.0.0.1',
    'port' => $port,
    'socket' => $socket,
  );
}

function wpdock_download_file(): void
{
  $token = sanitize_text_field($_GET['token'] ?? '');
  $file  = wpdock_resolve_token($token);

  if (! $file || ! file_exists($file)) {
    wpdock_json_error('File not found', 404);
  }

  $filename = basename($file);
  header('Content-Type: application/octet-stream');
  header('Content-Disposition: attachment; filename="' . $filename . '"');
  header('Content-Length: ' . filesize($file));
  readfile($file);

  // Clean up after download
  @unlink($file);
  wpdock_remove_token($token);
  exit;
}

// ── Token/temp file helpers ───────────────────────────────────────────────────

function wpdock_ensure_temp_dir(): void
{
  if (! is_dir(WPDOCK_TEMP_DIR)) {
    wp_mkdir_p(WPDOCK_TEMP_DIR);
    // Protect temp dir from direct web access
    file_put_contents(WPDOCK_TEMP_DIR . '/.htaccess', "Deny from all\n");
    file_put_contents(WPDOCK_TEMP_DIR . '/index.php', '<?php // Silence is golden');
  }
}

/**
 * Token store. Each token lives in its OWN small JSON file under the temp dir
 * (`tok-<token>.json`) instead of one shared `wpdock_temp_tokens` option.
 *
 * Why: the pull pipeline overlaps a part DOWNLOAD (which removes its token) with
 * the NEXT pack batch (which stores a new token). A single shared option is a
 * read-modify-write — two concurrent PHP requests would clobber each other's
 * update and lose a token ("File not found" on the next part). Independent files
 * have no shared-array race, so client-side pipelining is safe, and we also drop
 * a per-part DB write on big sites.
 */
function wpdock_token_file(string $token): string
{
  $token = preg_replace('/[^a-f0-9]/i', '', $token);
  return WPDOCK_TEMP_DIR . '/tok-' . $token . '.json';
}

function wpdock_store_temp_file(string $file_path): string
{
  wpdock_ensure_temp_dir();
  $token = bin2hex(random_bytes(16));
  wpdock_write_json_atomic(wpdock_token_file($token), array(
    'path'    => $file_path,
    'expires' => time() + 3600,
  ));
  return $token;
}

function wpdock_resolve_token(string $token): ?string
{
  $token = preg_replace('/[^a-f0-9]/i', '', (string) $token);
  if ($token === '') return null;
  $tok_file = wpdock_token_file($token);
  if (! file_exists($tok_file)) return null;
  $data = wpdock_read_json_array($tok_file);
  if (! is_array($data)) return null;
  if ((int) ($data['expires'] ?? 0) < time()) {
    wpdock_remove_token($token);
    return null;
  }
  return isset($data['path']) ? (string) $data['path'] : null;
}

function wpdock_remove_token(string $token): void
{
  $token = preg_replace('/[^a-f0-9]/i', '', (string) $token);
  if ($token === '') return;
  @unlink(wpdock_token_file($token));
}

function wpdock_delete_upload_session(string $upload_id, array &$sessions, bool $delete_chunks = false): void
{
  if (! isset($sessions[$upload_id])) {
    return;
  }

  $session = $sessions[$upload_id];
  $chunk_dir = (string) ($session['dir'] ?? '');
  if ($delete_chunks && $chunk_dir !== '' && is_dir($chunk_dir)) {
    $files = glob($chunk_dir . '/*');
    if (is_array($files)) {
      foreach ($files as $file) {
        @unlink($file);
      }
    }
    @rmdir($chunk_dir);
  }

  unset($sessions[$upload_id]);
}

// ── Response helpers ──────────────────────────────────────────────────────────

/**
 * Reset WordPress to a factory-fresh state (like a brand-new install), while
 * keeping everything the WPDock VS Code extension needs to stay connected:
 *
 *   - the administrator user (login, password hash, e-mail, role);
 *   - that user's Application Passwords (so HTTP Basic Auth keeps working);
 *   - the WPDock Agent plugin (re-activated) and its registered token transient;
 *   - the site address (siteurl/home).
 *
 * Everything else — posts, pages, comments, media references, options, other
 * plugins' data and activation state — is wiped and re-created from scratch by
 * WordPress's own installer. Plugin/theme *files* on disk are left untouched
 * (matching the behaviour of "WP Reset"); they simply become deactivated.
 */
function wpdock_reset_wp(): void
{
  global $wpdb;

  if (! function_exists('wp_install')) {
    require_once ABSPATH . 'wp-admin/includes/upgrade.php';
  }
  if (! class_exists('WP_Application_Passwords')) {
    require_once ABSPATH . WPINC . '/class-wp-application-passwords.php';
  }

  // 1. Snapshot the site identity we want to keep.
  $siteurl     = get_option('siteurl');
  $home        = get_option('home');
  $blogname    = get_option('blogname');
  $admin_email = get_option('admin_email');
  $blog_public = (int) get_option('blog_public', 1);
  $locale      = get_locale();
  $agent_plugin = plugin_basename(__FILE__);            // wpdock-agent/wpdock-agent.php
  $agent_entry  = explode('/', $agent_plugin)[0];       // top-level item in /plugins to keep

  // Decide which theme stays on disk. WordPress refuses to render without an
  // active theme, and wp_install()/populate_options() picks an EXISTING core
  // default theme — so we must keep one before deleting the rest.
  $keep_theme = '';
  if (class_exists('WP_Theme')) {
    $core_default = WP_Theme::get_core_default_theme(); // newest twentytwenty* present on disk
    if ($core_default && $core_default->exists()) {
      $keep_theme = $core_default->get_stylesheet();
    }
  }
  if ($keep_theme === '' && defined('WP_DEFAULT_THEME')) {
    $maybe = wp_get_theme(WP_DEFAULT_THEME);
    if ($maybe->exists()) { $keep_theme = $maybe->get_stylesheet(); }
  }
  if ($keep_theme === '') {
    $current = wp_get_theme();
    if ($current->exists()) { $keep_theme = $current->get_stylesheet(); }
  }

  // 2. Pick the administrator to preserve — prefer the one that actually owns a
  //    WPDock Application Password, so the VS Code credentials keep working.
  $keep_user = null;
  $admins = get_users(array('role' => 'administrator', 'number' => 100, 'orderby' => 'ID', 'order' => 'ASC'));
  foreach ($admins as $candidate) {
    $aps = get_user_meta($candidate->ID, '_application_passwords', true);
    if (! empty($aps)) {
      $keep_user = $candidate;
      break;
    }
  }
  if (! $keep_user && ! empty($admins)) {
    $keep_user = $admins[0];
  }
  if (! $keep_user) {
    wpdock_json_error('Не найден администратор для сохранения — сброс отменён.', 500);
  }

  $u_login    = $keep_user->user_login;
  $u_pass     = $keep_user->user_pass;       // already hashed — restore verbatim
  $u_email    = $keep_user->user_email ?: $admin_email;
  $u_display  = $keep_user->display_name;
  $u_nicename = $keep_user->user_nicename;
  $u_app_pw   = get_user_meta($keep_user->ID, '_application_passwords', true);
  $wpdock_token = get_transient('wpdock_agent_token');

  error_log('[WPDock] reset_wp START keep_user=' . $u_login . ' prefix=' . $wpdb->prefix);

  // Suppress the "new site installed" e-mail wp_install() would otherwise send.
  add_filter('pre_wp_mail', '__return_true', 99);

  // 2b. Wipe content files so the site really looks freshly installed: remove
  //     every plugin except this agent, every theme except the kept default,
  //     empty the uploads folder and drop common cache drop-ins. Failures are
  //     non-fatal (permissions) — the DB reset below still proceeds.
  $removed = array('plugins' => 0, 'themes' => 0, 'uploads' => 0, 'dropins' => 0);

  $plugins_root = defined('WP_PLUGIN_DIR') ? WP_PLUGIN_DIR : WP_CONTENT_DIR . '/plugins';
  $keep_in_plugins = array('.', '..', 'index.php', $agent_entry);
  foreach ((array) @scandir($plugins_root) as $entry) {
    if (in_array($entry, $keep_in_plugins, true)) { continue; }
    wpdock_rrmdir($plugins_root . '/' . $entry);
    $removed['plugins']++;
  }

  $themes_root = function_exists('get_theme_root') ? get_theme_root() : WP_CONTENT_DIR . '/themes';
  foreach ((array) @scandir($themes_root) as $entry) {
    if ($entry === '.' || $entry === '..' || $entry === 'index.php') { continue; }
    if ($keep_theme !== '' && $entry === $keep_theme) { continue; }
    wpdock_rrmdir($themes_root . '/' . $entry);
    $removed['themes']++;
  }

  $uploads = wp_upload_dir();
  $uploads_base = ! empty($uploads['basedir']) ? $uploads['basedir'] : WP_CONTENT_DIR . '/uploads';
  if (is_dir($uploads_base)) {
    foreach ((array) @scandir($uploads_base) as $entry) {
      if ($entry === '.' || $entry === '..') { continue; }
      wpdock_rrmdir($uploads_base . '/' . $entry);
      $removed['uploads']++;
    }
  }

  foreach (array('object-cache.php', 'advanced-cache.php', 'db.php', 'maintenance.php') as $dropin) {
    $dropin_path = WP_CONTENT_DIR . '/' . $dropin;
    if (is_file($dropin_path) && @unlink($dropin_path)) { $removed['dropins']++; }
  }

  error_log('[WPDock] reset_wp files removed plugins=' . $removed['plugins'] . ' themes=' . $removed['themes'] . ' uploads=' . $removed['uploads'] . ' dropins=' . $removed['dropins'] . ' keep_theme=' . $keep_theme);

  // 3. Drop every table belonging to this install's prefix.
  $like   = $wpdb->esc_like($wpdb->prefix) . '%';
  $tables = $wpdb->get_col($wpdb->prepare('SHOW TABLES LIKE %s', $like));
  if (! is_array($tables) || empty($tables)) {
    remove_filter('pre_wp_mail', '__return_true', 99);
    wpdock_json_error('Не удалось получить список таблиц WordPress для сброса.', 500);
  }
  $wpdb->query('SET FOREIGN_KEY_CHECKS = 0');
  foreach ($tables as $table) {
    $wpdb->query('DROP TABLE IF EXISTS `' . str_replace('`', '', $table) . '`');
  }
  $wpdb->query('SET FOREIGN_KEY_CHECKS = 1');

  // 4. Fresh install on the same prefix (recreates tables + default content).
  wp_cache_flush();
  $result = wp_install($blogname, $u_login, $u_email, $blog_public, '', wp_generate_password(24, true), $locale);
  $new_user_id = (int) ($result['user_id'] ?? 0);
  if ($new_user_id <= 0) {
    remove_filter('pre_wp_mail', '__return_true', 99);
    error_log('[WPDock] reset_wp ERROR wp_install returned no user_id');
    wpdock_json_error('WordPress не удалось переустановить (wp_install не вернул пользователя).', 500);
  }

  // 5. Restore the original site address.
  update_option('siteurl', $siteurl);
  update_option('home', $home);

  // 6. Restore admin credentials so VS Code <-> agent auth survives untouched.
  $wpdb->update(
    $wpdb->users,
    array(
      'user_pass'     => $u_pass,
      'user_email'    => $u_email,
      'display_name'  => $u_display,
      'user_nicename' => $u_nicename,
    ),
    array('ID' => $new_user_id)
  );
  if (! empty($u_app_pw)) {
    update_user_meta($new_user_id, '_application_passwords', $u_app_pw);
  }
  clean_user_cache($new_user_id);

  // 7. Re-activate the WPDock agent (a fresh install clears active_plugins).
  //    Write the option directly to avoid re-including this still-loaded file.
  $active = (array) get_option('active_plugins', array());
  if (! in_array($agent_plugin, $active, true)) {
    $active[] = $agent_plugin;
    update_option('active_plugins', $active);
  }

  // 8. Restore the agent token transient + the temp-cleanup cron.
  if (! empty($wpdock_token)) {
    set_transient('wpdock_agent_token', $wpdock_token, DAY_IN_SECONDS * 30);
  }
  if (! wp_next_scheduled('wpdock_cleanup_temp')) {
    wp_schedule_event(time(), 'hourly', 'wpdock_cleanup_temp');
  }

  remove_filter('pre_wp_mail', '__return_true', 99);

  error_log('[WPDock] reset_wp SUCCESS user_id=' . $new_user_id . ' login=' . $u_login);
  wpdock_json_success(array(
    'reset'      => true,
    'version'    => WPDOCK_AGENT_VERSION,
    'user_login' => $u_login,
    'user_id'    => $new_user_id,
    'siteurl'    => $siteurl,
    'keep_theme' => $keep_theme,
    'removed'    => $removed,
  ));
}

/**
 * Recursively delete a file, symlink or directory. Best-effort: silently skips
 * anything it cannot remove (kept intentionally simple — no WP_Filesystem creds).
 */
function wpdock_rrmdir(string $path): void
{
  if (is_link($path) || is_file($path)) {
    @unlink($path);
    return;
  }
  if (! is_dir($path)) {
    return;
  }
  $items = @scandir($path);
  if (is_array($items)) {
    foreach ($items as $item) {
      if ($item === '.' || $item === '..') { continue; }
      wpdock_rrmdir($path . DIRECTORY_SEPARATOR . $item);
    }
  }
  @rmdir($path);
}

function wpdock_json_success(array $data): void
{
  header('Content-Type: application/json');
  echo wp_json_encode(array('success' => true, 'data' => $data));
  exit;
}

function wpdock_json_error(string $message, int $status = 400): void
{
  http_response_code($status);
  header('Content-Type: application/json');
  echo wp_json_encode(array('success' => false, 'message' => $message));
  exit;
}

// ── Cleanup cron ─────────────────────────────────────────────────────────────

register_activation_hook(__FILE__, function () {
  if (! wp_next_scheduled('wpdock_cleanup_temp')) {
    wp_schedule_event(time(), 'hourly', 'wpdock_cleanup_temp');
  }
});

register_deactivation_hook(__FILE__, function () {
  wp_clear_scheduled_hook('wpdock_cleanup_temp');
});

add_action('wpdock_cleanup_temp', function () {
  $now = time();

  // Per-file tokens (`tok-<token>.json`): drop expired ones plus their payload.
  $tok_files = glob(WPDOCK_TEMP_DIR . '/tok-*.json');
  if (is_array($tok_files)) {
    foreach ($tok_files as $tok_file) {
      $data = wpdock_read_json_array($tok_file);
      if (! is_array($data) || (int) ($data['expires'] ?? 0) < $now) {
        if (is_array($data) && isset($data['path'])) {
          @unlink((string) $data['path']);
        }
        @unlink($tok_file);
      }
    }
  }

  // Legacy option-based tokens (pre-1.3.4): drain any leftovers once.
  $legacy = get_option('wpdock_temp_tokens', array());
  if (is_array($legacy) && ! empty($legacy)) {
    foreach ($legacy as $data) {
      if (isset($data['path'])) {
        @unlink((string) $data['path']);
      }
    }
    delete_option('wpdock_temp_tokens');
  }

  $sessions = get_option('wpdock_upload_sessions', array());
  foreach ($sessions as $upload_id => $data) {
    if (($data['expires'] ?? 0) < $now) {
      wpdock_delete_upload_session((string) $upload_id, $sessions, true);
    }
  }
  update_option('wpdock_upload_sessions', $sessions, false);

  // Sweep leftovers from abandoned incremental pack jobs (manifest/job state and
  // partial zips are not token-registered, so they aren't covered above).
  $stale = glob(WPDOCK_TEMP_DIR . '/pack-*');
  if (is_array($stale)) {
    foreach ($stale as $file) {
      if (is_file($file) && (@filemtime($file) < $now - 6 * 3600)) {
        @unlink($file);
      }
    }
  }
});
