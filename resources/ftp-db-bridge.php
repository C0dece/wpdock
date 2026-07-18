<?php
/**
 * One-shot WPDock FTP DB bridge.
 *
 * This file is uploaded to the WordPress root via FTP with a random name and
 * token, called once over HTTP, then removed by WPDock. It intentionally does
 * not register a plugin or persist state in WordPress.
 */

define('WPDOCK_FTP_DB_BRIDGE_SECRET', '__WPDOCK_SECRET__');
define('WPDOCK_FTP_DB_BRIDGE_SQL', '__WPDOCK_SQL_NAME__');

@ini_set('display_errors', '0');
@ini_set('memory_limit', '-1');
@set_time_limit(0);
@ignore_user_abort(true);
if (function_exists('ob_start')) {
  @ob_start();
}

if (! function_exists('hash_equals')) {
  function hash_equals($known_string, $user_string) {
    if (! is_string($known_string) || ! is_string($user_string)) {
      return false;
    }
    if (strlen($known_string) !== strlen($user_string)) {
      return false;
    }
    $result = 0;
    for ($i = 0; $i < strlen($known_string); $i++) {
      $result |= ord($known_string[$i]) ^ ord($user_string[$i]);
    }
    return $result === 0;
  }
}

function wpdock_bridge_json($success, $data = array(), $message = '', $status = 200) {
  while (function_exists('ob_get_level') && ob_get_level() > 0) {
    @ob_end_clean();
  }
  http_response_code((int) $status);
  header('Content-Type: application/json; charset=utf-8');
  echo json_encode(array(
    'success' => (bool) $success,
    'data'    => $data,
    'message' => (string) $message,
  ), JSON_UNESCAPED_SLASHES);
  exit;
}

function wpdock_bridge_body() {
  $raw = file_get_contents('php://input');
  if (! is_string($raw) || trim($raw) === '') {
    return array();
  }
  $body = json_decode($raw, true);
  return is_array($body) ? $body : array();
}

function wpdock_bridge_sql_path() {
  return __DIR__ . DIRECTORY_SEPARATOR . basename(WPDOCK_FTP_DB_BRIDGE_SQL);
}

function wpdock_bridge_cleanup_files() {
  @unlink(wpdock_bridge_sql_path());
  @unlink(__FILE__);
}

$token = isset($_GET['token']) ? (string) $_GET['token'] : (string) ($_SERVER['HTTP_X_WPDOCK_DB_TOKEN'] ?? '');
if (! hash_equals(WPDOCK_FTP_DB_BRIDGE_SECRET, $token)) {
  wpdock_bridge_json(false, array(), 'Invalid WPDock DB bridge token', 403);
}

$action = isset($_GET['action']) ? preg_replace('/[^a-z_]/', '', strtolower((string) $_GET['action'])) : '';
if ($action === 'cleanup') {
  wpdock_bridge_cleanup_files();
  wpdock_bridge_json(true, array('cleaned' => true));
}

$wp_load = __DIR__ . DIRECTORY_SEPARATOR . 'wp-load.php';
if (! is_file($wp_load)) {
  wpdock_bridge_json(false, array(), 'wp-load.php not found. FTP root must be the WordPress root.', 500);
}

require_once $wp_load;

if (empty($GLOBALS['wpdb'])) {
  wpdock_bridge_json(false, array(), 'WordPress database object is unavailable', 500);
}

function wpdock_bridge_ident($name) {
  $q = chr(96);
  return $q . str_replace($q, $q . $q, (string) $name) . $q;
}

function wpdock_bridge_sql_literal($value) {
  global $wpdb;
  if ($value === null) {
    return 'NULL';
  }
  if (is_bool($value)) {
    $value = $value ? '1' : '0';
  }
  $value = (string) $value;
  if (is_object($wpdb) && method_exists($wpdb, '_real_escape')) {
    $value = $wpdb->_real_escape($value);
  } elseif (function_exists('esc_sql')) {
    $value = esc_sql($value);
  } else {
    $value = addslashes($value);
  }
  return "'" . $value . "'";
}

function wpdock_bridge_tables($prefix = null) {
  global $wpdb;
  if ($prefix !== null && $prefix !== '') {
    $like = method_exists($wpdb, 'esc_like') ? $wpdb->esc_like($prefix) . '%' : addcslashes($prefix, '_%\\') . '%';
    $tables = $wpdb->get_col($wpdb->prepare('SHOW TABLES LIKE %s', $like));
  } else {
    $tables = $wpdb->get_col('SHOW TABLES');
  }
  $out = array();
  foreach ((array) $tables as $table) {
    $table = (string) $table;
    if ($table !== '') {
      $out[] = $table;
    }
  }
  sort($out);
  return $out;
}

function wpdock_bridge_export_db() {
  global $wpdb;
  $sql_file = wpdock_bridge_sql_path();
  $prefix = (string) ($wpdb->prefix ?? 'wp_');
  $tables = wpdock_bridge_tables($prefix);
  if (empty($tables)) {
    $tables = wpdock_bridge_tables(null);
  }

  $fh = @fopen($sql_file, 'wb');
  if (! $fh) {
    wpdock_bridge_json(false, array(), 'Cannot create SQL dump file in WordPress root', 500);
  }

  fwrite($fh, "-- WPDock FTP DB bridge dump\n");
  fwrite($fh, "SET SQL_MODE='NO_AUTO_VALUE_ON_ZERO';\n");
  fwrite($fh, "SET FOREIGN_KEY_CHECKS=0;\n\n");

  $stats = array();
  foreach ($tables as $table) {
    $ident = wpdock_bridge_ident($table);
    $create = $wpdb->get_row('SHOW CREATE TABLE ' . $ident, ARRAY_N);
    if (! is_array($create) || empty($create[1])) {
      continue;
    }
    fwrite($fh, "\nDROP TABLE IF EXISTS " . $ident . ";\n");
    fwrite($fh, $create[1] . ";\n\n");

    $count = (int) $wpdb->get_var('SELECT COUNT(*) FROM ' . $ident);
    $stats[$table] = $count;
    $limit = 300;
    for ($offset = 0; $offset < $count; $offset += $limit) {
      $rows = $wpdb->get_results('SELECT * FROM ' . $ident . ' LIMIT ' . (int) $limit . ' OFFSET ' . (int) $offset, ARRAY_N);
      foreach ((array) $rows as $row) {
        $values = array();
        foreach ((array) $row as $value) {
          $values[] = wpdock_bridge_sql_literal($value);
        }
        fwrite($fh, 'INSERT INTO ' . $ident . ' VALUES (' . implode(', ', $values) . ");\n");
      }
    }
    fwrite($fh, "\n");
  }

  fwrite($fh, "SET FOREIGN_KEY_CHECKS=1;\n");
  fclose($fh);

  clearstatcache(true, $sql_file);
  if (! is_file($sql_file) || filesize($sql_file) < 128) {
    wpdock_bridge_json(false, array(), 'DB export produced an empty SQL dump', 500);
  }

  wpdock_bridge_json(true, array(
    'file'        => basename($sql_file),
    'file_size'   => (int) filesize($sql_file),
    'dump_method' => 'ftp-bridge-php',
    'db_stats'    => array(
      'prefix' => $prefix,
      'tables' => $stats,
    ),
  ));
}

function wpdock_bridge_detect_prefix($sql) {
  preg_match_all('/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`([^`]+)`/i', $sql, $matches);
  $tables = array_values(array_unique((array) ($matches[1] ?? array())));
  $suffixes = array(
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
  foreach ($tables as $table) {
    $lower = strtolower((string) $table);
    foreach ($suffixes as $suffix) {
      $len = strlen($suffix);
      if (strlen($lower) > $len && substr($lower, -$len) === $suffix) {
        $candidate = substr((string) $table, 0, strlen((string) $table) - $len);
        if ($candidate !== '' && preg_match('/^[a-z0-9_]+$/i', $candidate)) {
          return $candidate;
        }
      }
    }
  }
  return 'wp_';
}

function wpdock_bridge_parse_db_host($db_host) {
  $host = (string) $db_host;
  $port = 0;
  $socket = '';
  if (strpos($host, ':') !== false) {
    $parts = explode(':', $host, 2);
    $host = $parts[0] !== '' ? $parts[0] : 'localhost';
    $tail = (string) ($parts[1] ?? '');
    if ($tail !== '' && ctype_digit($tail)) {
      $port = (int) $tail;
    } elseif ($tail !== '') {
      $socket = $tail;
    }
  }
  return array('host' => $host, 'port' => $port, 'socket' => $socket);
}

function wpdock_bridge_import_sql($sql) {
  if (! function_exists('mysqli_init')) {
    return array('success' => false, 'error' => 'mysqli extension is unavailable');
  }
  $parsed = wpdock_bridge_parse_db_host(DB_HOST);
  $mysqli = mysqli_init();
  if (! $mysqli) {
    return array('success' => false, 'error' => 'mysqli_init failed');
  }
  @mysqli_options($mysqli, MYSQLI_OPT_CONNECT_TIMEOUT, 30);
  $ok = @mysqli_real_connect(
    $mysqli,
    (string) ($parsed['host'] ?? 'localhost'),
    DB_USER,
    DB_PASSWORD,
    DB_NAME,
    (int) ($parsed['port'] ?? 0),
    (string) ($parsed['socket'] ?? '')
  );
  if (! $ok) {
    $error = mysqli_connect_error() ?: 'Cannot connect to MySQL';
    @mysqli_close($mysqli);
    return array('success' => false, 'error' => $error);
  }
  @mysqli_set_charset($mysqli, 'utf8mb4');
  if (! @mysqli_multi_query($mysqli, $sql)) {
    $error = mysqli_error($mysqli) ?: 'SQL import failed';
    @mysqli_close($mysqli);
    return array('success' => false, 'error' => $error);
  }
  $statements = 1;
  $last_error = '';
  do {
    $result = @mysqli_store_result($mysqli);
    if ($result instanceof mysqli_result) {
      @mysqli_free_result($result);
    }
    $err = mysqli_error($mysqli);
    if ($err !== '') {
      $last_error = $err;
    }
    if (! @mysqli_more_results($mysqli)) {
      break;
    }
    if (! @mysqli_next_result($mysqli)) {
      $last_error = mysqli_error($mysqli) ?: $last_error;
      break;
    }
    $statements++;
  } while (true);
  @mysqli_close($mysqli);
  if ($last_error !== '') {
    return array('success' => false, 'error' => $last_error, 'statements' => $statements);
  }
  return array('success' => true, 'statements' => $statements);
}

function wpdock_bridge_option_set($table, $name, $value, $autoload = 'yes') {
  global $wpdb;
  $updated = $wpdb->update($table, array('option_value' => $value), array('option_name' => $name));
  $exists = (int) $wpdb->get_var(
    $wpdb->prepare('SELECT COUNT(*) FROM ' . wpdock_bridge_ident($table) . ' WHERE option_name = %s', $name)
  );
  if ($updated === false || $exists === 0) {
    $wpdb->replace($table, array(
      'option_name'  => $name,
      'option_value' => $value,
      'autoload'     => $autoload,
    ));
  }
}

function wpdock_bridge_import_db() {
  global $wpdb;
  $body = wpdock_bridge_body();
  $sql_file = wpdock_bridge_sql_path();
  $target_url = isset($body['target_url']) ? (string) $body['target_url'] : '';
  if ($target_url !== '') {
    $target_url = function_exists('esc_url_raw') ? esc_url_raw($target_url) : filter_var($target_url, FILTER_SANITIZE_URL);
  }
  $preserve_credentials = array_key_exists('preserve_credentials', $body) ? (bool) $body['preserve_credentials'] : true;

  if (! is_file($sql_file)) {
    wpdock_bridge_json(false, array(), 'SQL file not found on FTP bridge', 404);
  }
  $sql = file_get_contents($sql_file);
  if (! is_string($sql) || trim($sql) === '') {
    wpdock_bridge_json(false, array(), 'SQL dump is empty', 400);
  }

  $remote_prefix = (string) ($wpdb->prefix ?? 'wp_');
  $source_prefix = wpdock_bridge_detect_prefix($sql);
  if ($source_prefix !== $remote_prefix) {
    $sql = str_replace('`' . $source_prefix, '`' . $remote_prefix, $sql);
  }

  $saved_users = array();
  $saved_usermeta = array();
  $saved_auth_options = array();
  $saved_active_plugins = null;
  if ($preserve_credentials) {
    $tables = wpdock_bridge_tables(null);
    $users_table = $remote_prefix . 'users';
    $usermeta_table = $remote_prefix . 'usermeta';
    $options_table = $remote_prefix . 'options';
    if (in_array($users_table, $tables, true)) {
      $saved_users = (array) $wpdb->get_results('SELECT * FROM ' . wpdock_bridge_ident($users_table), ARRAY_A);
    }
    if (in_array($usermeta_table, $tables, true) && ! empty($saved_users)) {
      $ids = array_map('intval', array_column($saved_users, 'ID'));
      $saved_usermeta = (array) $wpdb->get_results(
        'SELECT * FROM ' . wpdock_bridge_ident($usermeta_table) . ' WHERE user_id IN (' . implode(',', $ids) . ')',
        ARRAY_A
      );
    }
    if (in_array($options_table, $tables, true)) {
      $auth_names = array('auth_key', 'secure_auth_key', 'logged_in_key', 'nonce_key', 'auth_salt', 'secure_auth_salt', 'logged_in_salt', 'nonce_salt');
      $escaped = array_map(function ($name) {
        return wpdock_bridge_sql_literal($name);
      }, $auth_names);
      $saved_auth_options = (array) $wpdb->get_results(
        'SELECT option_name, option_value FROM ' . wpdock_bridge_ident($options_table) . ' WHERE option_name IN (' . implode(',', $escaped) . ')',
        ARRAY_A
      );
      $saved_active_plugins = $wpdb->get_var(
        $wpdb->prepare('SELECT option_value FROM ' . wpdock_bridge_ident($options_table) . ' WHERE option_name = %s', 'active_plugins')
      );
    }
  }

  $wpdb->query('SET FOREIGN_KEY_CHECKS = 0');
  $dropped = 0;
  foreach (wpdock_bridge_tables($remote_prefix) as $table) {
    $wpdb->query('DROP TABLE IF EXISTS ' . wpdock_bridge_ident($table));
    $dropped++;
  }
  $wpdb->query('SET FOREIGN_KEY_CHECKS = 1');

  $result = wpdock_bridge_import_sql($sql);
  if (empty($result['success'])) {
    wpdock_bridge_json(false, $result, (string) ($result['error'] ?? 'DB import failed'), 500);
  }

  $options_table = $remote_prefix . 'options';
  $usermeta_table = $remote_prefix . 'usermeta';
  if ($source_prefix !== $remote_prefix) {
    $like = method_exists($wpdb, 'esc_like') ? $wpdb->esc_like($source_prefix) . '%' : addcslashes($source_prefix, '_%\\') . '%';
    $wpdb->query($wpdb->prepare(
      'UPDATE ' . wpdock_bridge_ident($options_table) . ' SET option_name = CONCAT(%s, SUBSTRING(option_name, %d)) WHERE option_name LIKE %s',
      $remote_prefix,
      strlen($source_prefix) + 1,
      $like
    ));
    $wpdb->query($wpdb->prepare(
      'UPDATE ' . wpdock_bridge_ident($usermeta_table) . ' SET meta_key = CONCAT(%s, SUBSTRING(meta_key, %d)) WHERE meta_key LIKE %s',
      $remote_prefix,
      strlen($source_prefix) + 1,
      $like
    ));
  }

  if ($target_url !== '') {
    $wpdb->update($options_table, array('option_value' => $target_url), array('option_name' => 'siteurl'));
    $wpdb->update($options_table, array('option_value' => $target_url), array('option_name' => 'home'));
  }

  $credentials_restored = false;
  if ($preserve_credentials && (! empty($saved_users) || ! empty($saved_auth_options) || $saved_active_plugins !== null)) {
    $users_table = $remote_prefix . 'users';
    foreach ($saved_users as $row) {
      $wpdb->replace($users_table, $row);
    }
    foreach ($saved_usermeta as $row) {
      if ($source_prefix !== $remote_prefix && isset($row['meta_key']) && strpos((string) $row['meta_key'], $source_prefix) === 0) {
        $row['meta_key'] = $remote_prefix . substr((string) $row['meta_key'], strlen($source_prefix));
      }
      $wpdb->replace($usermeta_table, $row);
    }
    foreach ($saved_auth_options as $row) {
      wpdock_bridge_option_set($options_table, (string) $row['option_name'], (string) $row['option_value']);
    }
    if ($saved_active_plugins !== null) {
      wpdock_bridge_option_set($options_table, 'active_plugins', (string) $saved_active_plugins);
    }
    $credentials_restored = true;
  }

  @unlink($sql_file);
  wpdock_bridge_json(true, array(
    'method'                => 'ftp-bridge-mysqli',
    'statements'            => (int) ($result['statements'] ?? 0),
    'dropped_tables'        => $dropped,
    'source_prefix'         => $source_prefix,
    'remote_prefix'         => $remote_prefix,
    'prefix_rewritten'      => ($source_prefix !== $remote_prefix),
    'credentials_preserved' => $credentials_restored,
  ));
}

try {
  if ($action === 'export') {
    wpdock_bridge_export_db();
  }
  if ($action === 'import') {
    wpdock_bridge_import_db();
  }
  wpdock_bridge_json(false, array(), 'Unknown WPDock DB bridge action', 400);
} catch (Throwable $e) {
  wpdock_bridge_json(false, array(), $e->getMessage(), 500);
} catch (Exception $e) {
  wpdock_bridge_json(false, array(), $e->getMessage(), 500);
}
