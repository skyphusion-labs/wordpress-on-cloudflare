<?php
/**
 * wp-config.php for the B2 spike. The database is D1 (see wp-content/db.php).
 * A deploy sets its keys through the WP_SALT Worker secret (see index.js).
 */
define( 'DB_NAME', 'wordpress' );
define( 'DB_USER', '' );
define( 'DB_PASSWORD', '' );
define( 'DB_HOST', '' );
define( 'DB_CHARSET', 'utf8mb4' );
define( 'DB_COLLATE', '' );

// AST translation cache (issue #173): on by default. Turn it off per request
// with the x-ast-cache-off header (same-binary A/B, no redeploy), or
// permanently with the BOOTSTRAP_AST_CACHE=off environment variable. Defined
// before wp-settings.php loads wp-content/db.php, so the driver sees it.
if ( ! defined( 'BOOTSTRAP_AST_CACHE' ) ) {
	if ( ! empty( $_SERVER['HTTP_X_AST_CACHE_OFF'] ) || 'off' === getenv( 'BOOTSTRAP_AST_CACHE' ) ) {
		define( 'BOOTSTRAP_AST_CACHE', 'off' );
	}
}

// The Worker writes wp-runtime.php at boot: keys derived from its WP_SALT secret,
// and WP_HOME from the request origin. Without it (local only) fixed keys apply.
if ( file_exists( __DIR__ . '/wp-runtime.php' ) ) {
	require __DIR__ . '/wp-runtime.php';
}
// In the checkout Container there is no wp-runtime.php. The Worker passes
// WP_SALT and the switches as environment variables; the keys are derived the
// same way as in index.js (SHA-256 of WP_SALT:NAME), so cookies, nonces and
// cart sessions are valid on both sides.
if ( getenv( 'WP_SALT' ) ) {
	foreach ( array( 'AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY', 'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT' ) as $skyphusion_key ) {
		defined( $skyphusion_key ) || define( $skyphusion_key, hash( 'sha256', getenv( 'WP_SALT' ) . ':' . $skyphusion_key ) );
	}
	defined( 'WP_DEBUG' ) || define( 'WP_DEBUG', false );
	getenv( 'R2_UPLOADS' ) && ! defined( 'R2_UPLOADS' ) && define( 'R2_UPLOADS', true );
	getenv( 'CF_IMAGES' ) && ! defined( 'CF_IMAGES' ) && define( 'CF_IMAGES', true );
	if ( ! defined( 'WP_HOME' ) && ! empty( $_SERVER['HTTP_HOST'] ) ) {
		define( 'WP_HOME', 'https://' . $_SERVER['HTTP_HOST'] );
	}
	// Requests come through the Worker over HTTPS.
	$_SERVER['HTTPS'] = 'on';
}
foreach ( array( 'AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY', 'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT' ) as $skyphusion_key ) {
	if ( ! defined( $skyphusion_key ) ) {
		define( $skyphusion_key, 'local-spike-only-' . $skyphusion_key );
	}
}

// Approach A: Free and Paid share one MySQL database with different prefixes.
$table_prefix = getenv( 'WP_TABLE_PREFIX' ) ?: 'wp_';

// WooCommerce writes log files under uploads/wc-logs. Uploads live in R2, so
// every log line was an R2 read and write: about 30 calls and 15 s of each
// checkout (measured 2026-11-04). Logs go to local disk instead.
define( 'WC_LOG_DIR', '/tmp/wc-logs/' );

if ( ! defined( 'WP_HOME' ) ) {
	define( 'WP_HOME', 'http://localhost:8797' );
}
if ( ! defined( 'WP_SITEURL' ) ) {
	define( 'WP_SITEURL', WP_HOME );
}
// wp-runtime.php sets WP_DEBUG to false on a deploy. Locally, errors show.
if ( ! defined( 'WP_DEBUG' ) ) {
	define( 'WP_DEBUG', true );
}
define( 'WP_DEBUG_DISPLAY', WP_DEBUG );
define( 'DISABLE_WP_CRON', true );
define( 'AUTOMATIC_UPDATER_DISABLED', true );
// Issue #578. wp-admin loads each core script as its own static file, not through
// load-scripts.php and load-styles.php. PHP's files hold no core .js (build.sh): the static
// copies are served by Workers static assets. load-scripts.php reads each script from PHP's
// files, so it answered one newline per script, and wp-admin had no jQuery. A static file needs
// no PHP request. Core turns concatenation off on every public page already, and with
// SCRIPT_DEBUG.
define( 'CONCATENATE_SCRIPTS', false );
// Outbound HTTP goes through the Worker (wp-content/mu-plugins/http-bridge.php,
// issue #26). With HTTP_BRIDGE=off the Worker defines WP_HTTP_BLOCK_EXTERNAL in
// wp-runtime.php instead, as before: PHP has no sockets, so a request fails fast.

if ( ! defined( 'ABSPATH' ) ) {
	define( 'ABSPATH', __DIR__ . '/' );
}
require_once ABSPATH . 'wp-settings.php';
