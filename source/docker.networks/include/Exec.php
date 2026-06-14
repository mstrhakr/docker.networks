<?php

declare(strict_types=1);

error_reporting(E_ALL);
ini_set('display_errors', '0');

$bootstrapAction = isset($_REQUEST['action']) ? strtolower(trim((string) $_REQUEST['action'])) : '';
if ($bootstrapAction !== 'listenupdates') {
    header('Content-Type: application/json');
}

register_shutdown_function(static function (): void {
    $lastError = error_get_last();
    if ($lastError === null) {
        return;
    }

    $type = (int) ($lastError['type'] ?? 0);
    $fatalTypes = [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR, E_RECOVERABLE_ERROR];
    if (!in_array($type, $fatalTypes, true)) {
        return;
    }

    if (!headers_sent()) {
        http_response_code(500);
        header('Content-Type: application/json');
    }

    $payload = [
        'success' => false,
        'error' => 'Endpoint fatal error',
        'details' => [
            'type' => $lastError['type'] ?? null,
            'message' => $lastError['message'] ?? 'unknown',
            'file' => basename((string) ($lastError['file'] ?? '')),
            'line' => $lastError['line'] ?? null,
        ],
    ];

    echo json_encode($payload);
});

$loggerFile = __DIR__ . '/Logger.php';
$functionsFile = __DIR__ . '/ExecFunctions.php';

if (!is_file($loggerFile) || !is_file($functionsFile)) {
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'error' => 'Endpoint bootstrap files missing',
        'details' => [
            'logger' => is_file($loggerFile),
            'functions' => is_file($functionsFile),
        ],
    ]);
    return;
}

require_once $loggerFile;
require_once $functionsFile;

try {
    $request = dockerNetworksBuildRequest();
    dockerNetworksDispatchAction($request);
} catch (Throwable $e) {
    dockerNetworksLogger('Exec endpoint exception: ' . $e->getMessage(), ['trace' => $e->getTraceAsString()], 'daemon', 'error', 'exec');
    dockerNetworksRespond(['success' => false, 'error' => $e->getMessage()], 500);
}
