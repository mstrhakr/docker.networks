<?php

declare(strict_types=1);

require_once __DIR__ . '/Logger.php';

/**
 * Request/response helpers and action handlers for Docker Networks Exec endpoint.
 *
 * Keeping handler logic in this file makes it easier to unit-test behavior
 * without executing endpoint bootstrapping side effects.
 */

function dockerNetworksBuildRequest(): array
{
    $request = [];

    if (is_array($_GET)) {
        $request = array_merge($request, $_GET);
    }

    if (is_array($_POST)) {
        $request = array_merge($request, $_POST);
    }

    $raw = file_get_contents('php://input');
    if (is_string($raw) && $raw !== '') {
        $decoded = json_decode($raw, true);
        if (is_array($decoded)) {
            $request = array_merge($request, $decoded);
        }
    }

    return $request;
}

function dockerNetworksEnsureLocalRequest(): bool
{
    // Requests originate from browser clients, so REMOTE_ADDR is often not localhost.
    // Allow webgui-authenticated requests and rely on action-level sanitization.
    return true;
}

function dockerNetworksDispatchAction(array $request): void
{
    $action = isset($request['action']) ? strtolower(trim((string) $request['action'])) : '';
    if (dockerNetworksShouldLogApiCalls()) {
        dockerNetworksLogger('API action request', ['action' => $action], 'daemon', 'debug', 'api');
    }

    switch ($action) {
        case 'listenupdates':
            dockerNetworksHandleListenUpdates($request);
            return;
        case 'signalbatchcomplete':
            dockerNetworksHandleSignalBatchComplete($request);
            return;
        case 'dockerlogger':
            dockerNetworksHandleClientLog($request);
            return;
        case 'list':
            dockerNetworksHandleListNetworks();
            return;
        case 'create':
            dockerNetworksHandleCreateNetwork($request);
            return;
        case 'delete':
            dockerNetworksHandleDeleteNetwork($request);
            return;
        case 'update':
            dockerNetworksHandleUpdateNetwork($request);
            return;
        case 'connect':
            dockerNetworksHandleConnectContainer($request);
            return;
        case 'disconnect':
            dockerNetworksHandleDisconnectContainer($request);
            return;
        case 'containers':
            dockerNetworksHandleListContainers();
            return;
        case 'checkschedulednetworks':
            dockerNetworksHandleCheckScheduledNetworks($request);
            return;
        default:
            dockerNetworksRespond(['success' => false, 'error' => 'Invalid action'], 400);
            return;
    }
}

function dockerNetworksSseBaseDir(): string
{
    return '/tmp/docker.networks-sse';
}

function dockerNetworksSseQueuePath(string $requestId): string
{
    return dockerNetworksSseBaseDir() . '/' . sha1($requestId) . '.queue';
}

function dockerNetworksSseEnsureDir(): bool
{
    $dir = dockerNetworksSseBaseDir();
    if (is_dir($dir)) {
        return true;
    }

    return @mkdir($dir, 0777, true) || is_dir($dir);
}

function dockerNetworksSseEmitQueuedEvent(string $requestId, string $eventType, array $payload): void
{
    if ($requestId === '' || !dockerNetworksSseEnsureDir()) {
        return;
    }

    $record = [
        'event' => $eventType,
        'payload' => $payload,
        'ts' => time(),
    ];

    $json = json_encode($record, JSON_UNESCAPED_SLASHES);
    if ($json === false) {
        return;
    }

    @file_put_contents(dockerNetworksSseQueuePath($requestId), $json . "\n", FILE_APPEND | LOCK_EX);
}

function dockerNetworksHandleListenUpdates(array $request): void
{
    $requestId = isset($request['requestId']) ? trim((string) $request['requestId']) : '';
    if ($requestId === '') {
        if (!headers_sent()) {
            http_response_code(400);
            header('Content-Type: application/json');
        }
        echo json_encode(['success' => false, 'error' => 'requestId is required']);
        return;
    }

    @set_time_limit(0);

    if (!headers_sent()) {
        http_response_code(200);
        header('Content-Type: text/event-stream');
        header('Cache-Control: no-cache');
        header('Connection: keep-alive');
        header('X-Accel-Buffering: no');
    }

    $queuePath = dockerNetworksSseQueuePath($requestId);
    $offset = 0;
    $startedAt = time();
    $idleSeconds = 0;
    $maxDurationSeconds = 180;
    $maxIdleSeconds = 45;

    while (!connection_aborted()) {
        clearstatcache(true, $queuePath);
        $hasNewData = false;
        $shouldTerminate = false;

        if (is_file($queuePath)) {
            $content = @file_get_contents($queuePath);
            if (is_string($content) && $content !== '') {
                $len = strlen($content);
                if ($len > $offset) {
                    $chunk = substr($content, $offset);
                    $offset = $len;
                    $lines = explode("\n", $chunk);
                    foreach ($lines as $line) {
                        $line = trim($line);
                        if ($line === '') {
                            continue;
                        }

                        $record = json_decode($line, true);
                        if (!is_array($record) || !isset($record['event']) || !isset($record['payload'])) {
                            continue;
                        }

                        echo 'event: ' . (string) $record['event'] . "\n";
                        echo 'data: ' . json_encode($record['payload'], JSON_UNESCAPED_SLASHES) . "\n\n";
                        $hasNewData = true;
                        if ((string) $record['event'] === 'complete') {
                            $shouldTerminate = true;
                        }
                    }
                }
            }
        }

        if ($hasNewData) {
            $idleSeconds = 0;
            @ob_flush();
            @flush();
        } else {
            $idleSeconds++;
            // Keep connection alive for proxies.
            echo ": keepalive\n\n";
            @ob_flush();
            @flush();
        }

        if ((time() - $startedAt) >= $maxDurationSeconds || $idleSeconds >= $maxIdleSeconds) {
            echo "event: complete\n";
            echo "data: {}\n\n";
            @ob_flush();
            @flush();
            break;
        }

        if ($shouldTerminate) {
            @ob_flush();
            @flush();
            break;
        }

        usleep(300000);
    }

    // Best effort cleanup once stream ends.
    if (is_file($queuePath)) {
        @unlink($queuePath);
    }
}

function dockerNetworksHandleSignalBatchComplete(array $request): void
{
    $requestId = isset($request['requestId']) ? trim((string) $request['requestId']) : '';
    if ($requestId === '') {
        dockerNetworksRespond(['success' => false, 'error' => 'requestId is required'], 400);
        return;
    }

    dockerNetworksSseEmitQueuedEvent($requestId, 'complete', ['ok' => true]);
    dockerNetworksRespond(['success' => true]);
}

function dockerNetworksRespond(array $payload, int $statusCode = 200): void
{
    http_response_code($statusCode);
    echo json_encode($payload);
}

function dockerNetworksHandleClientLog(array $request): void
{
    $message = isset($request['msg']) ? (string) $request['msg'] : '';
    $type = isset($request['type']) ? (string) $request['type'] : 'user';
    $level = isset($request['lvl']) ? (string) $request['lvl'] : 'info';
    $category = isset($request['category']) ? (string) $request['category'] : 'ui';
    $data = $request['data'] ?? null;

    dockerNetworksLogger($message, $data, $type, $level, $category);
    dockerNetworksRespond(['success' => true]);
}

function dockerNetworksRun(string $command): array
{
    $output = [];
    $exitCode = 0;
    exec($command . ' 2>&1', $output, $exitCode);

    return [
        'exitCode' => $exitCode,
        'output' => trim(implode("\n", $output)),
    ];
}

function dockerNetworksPluginCfgPath(): string
{
    return '/boot/config/plugins/docker.networks/docker.networks.cfg';
}

function dockerNetworksLoadPluginCfg(): array
{
    $path = dockerNetworksPluginCfgPath();
    if (!is_file($path)) {
        return [];
    }

    $cfg = @parse_ini_file($path, false, INI_SCANNER_RAW);
    return is_array($cfg) ? $cfg : [];
}

function dockerNetworksExecCfgBool(array $cfg, string $key, bool $default = false): bool
{
    if (!isset($cfg[$key])) {
        return $default;
    }

    $value = strtolower(trim((string) $cfg[$key], " \t\n\r\0\x0B\"'"));
    return in_array($value, ['1', 'true', 'yes', 'on', 'preserve', 'enabled'], true);
}

function dockerNetworksIsTemplatePersistenceEnabled(): bool
{
    $cfg = dockerNetworksLoadPluginCfg();
    return dockerNetworksExecCfgBool($cfg, 'XML_TEMPLATE_PERSIST', false);
}

function dockerNetworksMetaPath(): string
{
    return '/boot/config/plugins/docker.networks/networks-meta.json';
}

function dockerNetworksLoadMeta(): array
{
    $path = dockerNetworksMetaPath();
    if (!is_file($path)) {
        return [];
    }

    $fp = @fopen($path, 'r');
    if ($fp === false) {
        return [];
    }

    $locked = flock($fp, LOCK_SH);
    $content = $locked ? file_get_contents($path) : '';
    if ($locked) {
        flock($fp, LOCK_UN);
    }
    fclose($fp);

    if ($content === '' || $content === false) {
        return [];
    }

    $decoded = json_decode($content, true);
    return is_array($decoded) ? $decoded : [];
}

function dockerNetworksSaveMeta(array $meta): bool
{
    $path = dockerNetworksMetaPath();
    $dir = dirname($path);
    if (!is_dir($dir) && !@mkdir($dir, 0777, true) && !is_dir($dir)) {
        return false;
    }

    $json = json_encode($meta, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    if ($json === false) {
        return false;
    }

    $fp = @fopen($path, 'w');
    if ($fp === false) {
        return false;
    }

    $locked = flock($fp, LOCK_EX);
    $written = $locked ? fwrite($fp, $json) !== false : false;
    if ($locked) {
        flock($fp, LOCK_UN);
    }
    fclose($fp);

    return $written;
}

function dockerNetworksMetaEntry(array $meta, array $network): array
{
    $id = isset($network['Id']) ? (string) $network['Id'] : '';
    $name = isset($network['Name']) ? (string) $network['Name'] : '';

    if ($id !== '' && isset($meta[$id]) && is_array($meta[$id])) {
        return $meta[$id];
    }

    if ($name !== '' && isset($meta[$name]) && is_array($meta[$name])) {
        return $meta[$name];
    }

    return [];
}

function dockerNetworksProtectionInfo(array $network): array
{
    $name = isset($network['Name']) ? strtolower(trim((string) $network['Name'])) : '';
    if (in_array($name, ['bridge', 'host', 'none'], true)) {
        return [
            'isDefault' => true,
            'isProtected' => true,
            'label' => 'Default',
        ];
    }

    // Interface-style names (e.g. wg0, br0) are typically system-managed.
    if (dockerNetworksIsSystemStyleName($name)) {
        return [
            'isDefault' => false,
            'isProtected' => true,
            'label' => 'System',
        ];
    }

    $labels = isset($network['Labels']) && is_array($network['Labels']) ? $network['Labels'] : [];
    if (($labels['com.docker.network.bridge.default_bridge'] ?? '') === 'true') {
        return [
            'isDefault' => true,
            'isProtected' => true,
            'label' => 'Default',
        ];
    }

    $driver = strtolower(trim((string) ($network['Driver'] ?? '')));
    $options = isset($network['Options']) && is_array($network['Options']) ? $network['Options'] : [];
    $parent = trim((string) ($options['parent'] ?? ''));
    if ($parent !== '' && in_array($driver, ['macvlan', 'ipvlan'], true)) {
        return [
            'isDefault' => false,
            'isProtected' => true,
            'label' => 'System',
        ];
    }

    return [
        'isDefault' => false,
        'isProtected' => false,
        'label' => '',
    ];
}

function dockerNetworksIsSystemStyleName(string $name): bool
{
    $name = strtolower(trim($name));
    if ($name === '') {
        return false;
    }

    // Keep heuristic conservative: only compact interface-style names, no separators.
    if (preg_match('/[^a-z0-9]/', $name)) {
        return false;
    }

    return (bool) preg_match('/^(?:wg|br|bond|vlan|virbr|docker|podman|tun|tap|zt|tailscale)\d+$/', $name);
}

function dockerNetworksInspectNetwork(string $idOrName): ?array
{
    $result = dockerNetworksRun('docker network inspect ' . escapeshellarg($idOrName));
    if ($result['exitCode'] !== 0) {
        return null;
    }

    $details = json_decode((string) $result['output'], true);
    if (!is_array($details) || !isset($details[0]) || !is_array($details[0])) {
        return null;
    }

    return $details[0];
}

/**
 * Validate IP address format (IPv4 only)
 */
function dockerNetworksValidateIpAddress(string $ip): array
{
    $ip = trim($ip);
    if ($ip === '') {
        return ['valid' => true, 'error' => '']; // empty is OK (auto-assign)
    }

    if (!filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
        return ['valid' => false, 'error' => 'Invalid IP address format'];
    }

    return ['valid' => true, 'error' => ''];
}

/**
 * Check if IP is within the network subnet
 */
function dockerNetworksIpInSubnet(string $ip, string $subnet): bool
{
    $parts = explode('/', $subnet);
    if (count($parts) !== 2) {
        return false;
    }

    $networkAddr = $parts[0];
    $prefixLen = (int)$parts[1];

    if (!filter_var($networkAddr, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) || $prefixLen < 0 || $prefixLen > 32) {
        return false;
    }

    $ipLong = ip2long($ip);
    $netLong = ip2long($networkAddr);
    $maskLong = -1 << (32 - $prefixLen);
    $maskLong &= 0xffffffff;

    return ($ipLong & $maskLong) === ($netLong & $maskLong);
}

/**
 * Check if IP is already in use on the network
 */
function dockerNetworksIsIpInUse(string $ip, string $networkId): bool
{
    $network = dockerNetworksInspectNetwork($networkId);
    if (!is_array($network) || !isset($network['Containers']) || !is_array($network['Containers'])) {
        return false;
    }

    foreach ($network['Containers'] as $container) {
        if (is_array($container) && isset($container['IPv4Address'])) {
            $containerIp = trim((string)$container['IPv4Address']);
            $containerIpOnly = explode('/', $containerIp)[0]; // remove subnet from address
            if ($containerIpOnly === $ip) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Get container's IP address on a specific network
 */
function dockerNetworksGetContainerNetworkIp(string $containerId, string $networkId): string
{
    $network = dockerNetworksInspectNetwork($networkId);
    if (!is_array($network) || !isset($network['Containers']) || !is_array($network['Containers'])) {
        return '';
    }

    foreach ($network['Containers'] as $container) {
        if (is_array($container) && isset($container['Name']) && ($container['Name'] === $containerId || strpos((string)$container['Name'], $containerId) !== false)) {
            $ipAddr = isset($container['IPv4Address']) ? trim((string)$container['IPv4Address']) : '';
            return explode('/', $ipAddr)[0]; // return just the IP without subnet
        }
    }

    return '';
}

/**
 * Check whether a container is currently attached to a network at runtime.
 */
function dockerNetworksIsContainerConnectedToNetwork(string $containerRef, string $networkId): bool
{
    $container = dockerNetworksInspectContainer($containerRef);
    if (!is_array($container)) {
        return false;
    }

    $containerName = isset($container['Name']) ? ltrim((string)$container['Name'], '/') : '';
    $containerFullId = isset($container['Id']) ? trim((string)$container['Id']) : '';

    $network = dockerNetworksInspectNetwork($networkId);
    if (!is_array($network) || !isset($network['Containers']) || !is_array($network['Containers'])) {
        return false;
    }

    foreach ($network['Containers'] as $attachedId => $attached) {
        $attachedName = is_array($attached) && isset($attached['Name']) ? trim((string)$attached['Name']) : '';
        $attachedIdStr = trim((string)$attachedId);

        if ($containerName !== '' && $attachedName === $containerName) {
            return true;
        }

        if ($containerFullId !== '' && $attachedIdStr !== '' && strpos($containerFullId, $attachedIdStr) === 0) {
            return true;
        }
    }

    return false;
}

/**
 * Count networks a container is connected to
 */
function dockerNetworksGetContainerNetworkCount(string $containerId): int
{
    $result = dockerNetworksRun('docker inspect --format={{json .NetworkSettings.Networks}} ' . escapeshellarg($containerId));
    if ($result['exitCode'] !== 0) {
        return 0;
    }

    $networks = json_decode((string)$result['output'], true);
    return is_array($networks) ? count($networks) : 0;
}

/**
 * Build pending network-attach counts from template PostArgs commands.
 * Returns map: lowercase network name => unique container count.
 */
function dockerNetworksBuildScheduledNetworkCounts(): array
{
    $dir = '/boot/config/plugins/dockerMan/templates-user';
    if (!is_dir($dir)) {
        return [];
    }

    $networkToContainers = [];
    $templates = glob($dir . '/my-*.xml') ?: [];
    foreach ($templates as $templatePath) {
        $xml = @simplexml_load_file((string)$templatePath);
        if ($xml === false) {
            continue;
        }

        $postArgs = isset($xml->PostArgs) ? trim((string)$xml->PostArgs) : '';
        if ($postArgs === '') {
            continue;
        }

        // Supports both managed and legacy command forms, with optional --ip and quoted args.
        $pattern = "/(?:^|&&|\\s)(?:\\/usr\\/bin\\/)?docker\\s+network\\s+connect(?:\\s+--ip\\s+[^\\s]+)?\\s+(?:'|\")?([^\\s'\"&]+)(?:'|\")?\\s+(?:'|\")?([^\\s'\"&]+)(?:'|\")?/i";
        if (!preg_match_all($pattern, $postArgs, $matches, PREG_SET_ORDER)) {
            continue;
        }

        foreach ($matches as $match) {
            $networkName = isset($match[1]) ? trim((string)$match[1]) : '';
            $containerName = isset($match[2]) ? trim((string)$match[2]) : '';
            if ($networkName === '' || $containerName === '') {
                continue;
            }

            $networkKey = strtolower($networkName);
            if (!isset($networkToContainers[$networkKey])) {
                $networkToContainers[$networkKey] = [];
            }
            $networkToContainers[$networkKey][$containerName] = true;
        }
    }

    $counts = [];
    foreach ($networkToContainers as $networkKey => $containerMap) {
        $counts[$networkKey] = count($containerMap);
    }

    return $counts;
}

function dockerNetworksHandleListNetworks(): void
{
    dockerNetworksLogger('Listing networks', null, 'daemon', 'debug', 'exec');
    $cmd = "docker network ls --format='{{json .}}'";
    $result = dockerNetworksRun($cmd);

    if ($result['exitCode'] !== 0) {
        dockerNetworksRespond(['success' => false, 'error' => $result['output'] ?: 'Failed to list networks'], 500);
        return;
    }

    $networks = [];
    $scheduledCounts = dockerNetworksBuildScheduledNetworkCounts();
    $meta = dockerNetworksLoadMeta();
    $lines = array_filter(explode("\n", (string) $result['output']));
    foreach ($lines as $line) {
        $network = json_decode($line, true);
        if (!is_array($network) || !isset($network['Name'])) {
            continue;
        }

        $entry = dockerNetworksInspectNetwork((string) $network['Name']);
        if (!is_array($entry)) {
            continue;
        }

        $metaEntry = dockerNetworksMetaEntry($meta, $entry);
        $protection = dockerNetworksProtectionInfo($entry);
        $entry['Description'] = isset($metaEntry['description']) ? (string) $metaEntry['description'] : '';
        $entry['IsDefault'] = $protection['isDefault'];
        $entry['IsProtected'] = $protection['isProtected'];
        $entry['ProtectionLabel'] = $protection['label'];
        $entry['PendingCount'] = (int)($scheduledCounts[strtolower((string)($entry['Name'] ?? ''))] ?? 0);
        $networks[] = $entry;
    }

    usort($networks, static function (array $a, array $b): int {
        $aProtected = !empty($a['IsProtected']);
        $bProtected = !empty($b['IsProtected']);
        if ($aProtected !== $bProtected) {
            return $aProtected ? -1 : 1;
        }

        return strcmp((string) ($a['Name'] ?? ''), (string) ($b['Name'] ?? ''));
    });

    dockerNetworksRespond(['success' => true, 'networks' => $networks]);
}

function dockerNetworksHandleCreateNetwork(array $request): void
{
    $name = isset($request['name']) ? trim((string) $request['name']) : '';
    if ($name === '') {
        dockerNetworksRespond(['success' => false, 'error' => 'Network name is required'], 400);
        return;
    }

    $driver = isset($request['driver']) && trim((string) $request['driver']) !== ''
        ? trim((string) $request['driver'])
        : 'bridge';

    $cmd = 'docker network create --driver ' . escapeshellarg($driver);

    $subnet = isset($request['subnet']) ? trim((string) $request['subnet']) : '';
    if ($subnet !== '') {
        $cmd .= ' --subnet ' . escapeshellarg($subnet);
    }

    $cmd .= ' ' . escapeshellarg($name);

    $result = dockerNetworksRun($cmd);
    if ($result['exitCode'] !== 0) {
        dockerNetworksLogger('Create network failed', ['output' => $result['output']], 'user', 'error', 'exec');
        dockerNetworksRespond(['success' => false, 'error' => $result['output'] ?: 'Failed to create network'], 500);
        return;
    }

    dockerNetworksLogger('Network created', ['name' => $name, 'id' => $result['output']], 'user', 'info', 'exec');

    dockerNetworksRespond(['success' => true, 'message' => 'Network created successfully', 'id' => $result['output']]);
}

function dockerNetworksHandleDeleteNetwork(array $request): void
{
    $id = isset($request['id']) ? trim((string) $request['id']) : '';
    if ($id === '') {
        dockerNetworksRespond(['success' => false, 'error' => 'Network ID is required'], 400);
        return;
    }

    $network = dockerNetworksInspectNetwork($id);
    if (!is_array($network)) {
        dockerNetworksRespond(['success' => false, 'error' => 'Network not found'], 404);
        return;
    }

    $protection = dockerNetworksProtectionInfo($network);
    if (!empty($protection['isProtected'])) {
        dockerNetworksLogger('Delete blocked for protected network', ['id' => $id, 'name' => $network['Name'] ?? '', 'label' => $protection['label']], 'user', 'warning', 'exec');
        dockerNetworksRespond(['success' => false, 'error' => trim(($protection['label'] ?: 'Protected') . ' Docker networks cannot be deleted')], 403);
        return;
    }

    $result = dockerNetworksRun('docker network rm ' . escapeshellarg($id));
    if ($result['exitCode'] !== 0) {
        $output = $result['output'] ?: '';
        
        // Better error message for connected containers
        if (stripos($output, 'active endpoints') !== false || stripos($output, 'busy') !== false) {
            $error = 'Network has connected containers. Disconnect all containers first using the Manage button.';
        } else {
            $error = $output ?: 'Failed to delete network';
        }
        
        dockerNetworksLogger('Delete network failed', ['id' => $id, 'output' => $result['output']], 'user', 'error', 'exec');
        dockerNetworksRespond(['success' => false, 'error' => $error], 500);
        return;
    }

    $meta = dockerNetworksLoadMeta();
    if (isset($meta[$id])) {
        unset($meta[$id]);
        dockerNetworksSaveMeta($meta);
    }

    dockerNetworksLogger('Network deleted', ['id' => $id], 'user', 'info', 'exec');
    dockerNetworksRespond(['success' => true, 'message' => 'Network deleted successfully']);
}

function dockerNetworksHandleUpdateNetwork(array $request): void
{
    $id = isset($request['id']) ? trim((string) $request['id']) : '';
    if ($id === '') {
        dockerNetworksRespond(['success' => false, 'error' => 'Network ID is required'], 400);
        return;
    }

    $result = dockerNetworksRun('docker network inspect ' . escapeshellarg($id));
    if ($result['exitCode'] !== 0) {
        dockerNetworksRespond(['success' => false, 'error' => 'Network not found'], 404);
        return;
    }

    $description = isset($request['description']) ? trim((string) $request['description']) : '';
    $inspect = json_decode((string) $result['output'], true);
    $name = '';
    if (is_array($inspect) && isset($inspect[0]) && is_array($inspect[0]) && isset($inspect[0]['Name'])) {
        $name = (string) $inspect[0]['Name'];
    }

    $meta = dockerNetworksLoadMeta();
    $meta[$id] = [
        'description' => $description,
        'name' => $name,
        'updatedAt' => gmdate('c'),
    ];

    if (!dockerNetworksSaveMeta($meta)) {
        dockerNetworksLogger('Update network metadata failed (save)', ['id' => $id], 'user', 'error', 'exec');
        dockerNetworksRespond(['success' => false, 'error' => 'Failed to save network metadata'], 500);
        return;
    }

    dockerNetworksLogger('Network metadata updated', ['id' => $id], 'user', 'info', 'exec');
    dockerNetworksRespond(['success' => true, 'message' => 'Network metadata updated', 'description' => $description]);
}

function dockerNetworksCheckContainerScheduledNetwork(string $containerName, string $networkName): bool
{
    $templatePath = dockerNetworksUserTemplatePath($containerName);
    if ($templatePath === '') {
        return false;
    }

    $xml = @simplexml_load_file($templatePath);
    if ($xml === false) {
        return false;
    }

    $postArgs = isset($xml->PostArgs) ? trim((string) $xml->PostArgs) : '';
    if ($postArgs === '') {
        return false;
    }

    // Check for both managed format (&& docker network connect) and legacy format
    $managedCmd = dockerNetworksBuildTemplateConnectCmd($networkName, $containerName);
    $legacyCmd = dockerNetworksBuildLegacyTemplateConnectCmd($networkName, $containerName);

    $normalizedPostArgs = strtolower(preg_replace('/\s+/', ' ', $postArgs) ?: '');
    $normalizedManaged = strtolower(preg_replace('/\s+/', ' ', $managedCmd) ?: '');
    $normalizedLegacy = strtolower(preg_replace('/\s+/', ' ', $legacyCmd) ?: '');

    return strpos($normalizedPostArgs, $normalizedManaged) !== false || strpos($normalizedPostArgs, $normalizedLegacy) !== false;
}

function dockerNetworksHandleCheckScheduledNetworks(array $request): void
{
    $networkId = isset($request['networkId']) ? trim((string) $request['networkId']) : '';

    if ($networkId === '') {
        dockerNetworksRespond(['success' => false, 'error' => 'Network ID is required'], 400);
        return;
    }

    $networkName = dockerNetworksResolveNetworkName($networkId);
    if ($networkName === '') {
        dockerNetworksRespond(['success' => false, 'error' => 'Network not found'], 404);
        return;
    }

    $psCommand = "docker ps -a --no-trunc --format='{{json .}}'";
    $result = dockerNetworksRun($psCommand);
    if ($result['exitCode'] !== 0) {
        dockerNetworksRespond(['success' => false, 'error' => $result['output'] ?: 'Failed to list containers'], 500);
        return;
    }

    $scheduledContainers = [];
    $lines = array_filter(explode("\n", (string) $result['output']));
    foreach ($lines as $line) {
        $row = json_decode($line, true);
        if (!is_array($row) || !isset($row['Names']) || !isset($row['ID'])) {
            continue;
        }

        $containerName = (string) $row['Names'];
        $containerId = (string) $row['ID'];

        if (dockerNetworksCheckContainerScheduledNetwork($containerName, $networkName)) {
            $scheduledContainers[] = [
                'id' => $containerId,
                'name' => $containerName,
            ];
        }
    }

    dockerNetworksRespond(['success' => true, 'scheduledContainers' => $scheduledContainers]);
}

function dockerNetworksHandleConnectContainer(array $request): void
{
    $networkId = isset($request['networkId']) ? trim((string) $request['networkId']) : '';
    $containerId = isset($request['containerId']) ? trim((string) $request['containerId']) : '';
    $containerNameHint = isset($request['containerName']) ? trim((string) $request['containerName']) : '';
    $ipAddress = isset($request['ipAddress']) ? trim((string) $request['ipAddress']) : '';
    $containerState = isset($request['containerState']) ? strtolower(trim((string) $request['containerState'])) : '';
    $requestId = isset($request['requestId']) ? trim((string) $request['requestId']) : '';

    if ($networkId === '' || $containerId === '') {
        dockerNetworksRespond(['success' => false, 'error' => 'Network ID and Container ID are required'], 400);
        return;
    }

    $containerRef = $containerId;
    $containerName = dockerNetworksResolveContainerName($containerRef);
    if ($containerName === '' && $containerNameHint !== '') {
        $containerRef = $containerNameHint;
        $containerName = dockerNetworksResolveContainerName($containerRef);
    }

    if ($containerName === '') {
        dockerNetworksRespond(['success' => false, 'error' => 'Container not found (it may have been removed or renamed). Refresh and try again.'], 404);
        return;
    }

    $networkName = dockerNetworksResolveNetworkName($networkId);
    if ($networkName === '') {
        dockerNetworksRespond(['success' => false, 'error' => 'Network not found'], 404);
        return;
    }

    // Trust docker inspect state over client-provided state when available.
    $resolvedState = dockerNetworksResolveContainerState($containerRef);
    if ($resolvedState !== '') {
        $containerState = $resolvedState;
    }

    // Only "running" should use direct docker network connect.
    $isContainerRunning = ($containerState === 'running');
    $isPersistenceEnabled = dockerNetworksIsTemplatePersistenceEnabled();

    if (!$isContainerRunning) {
        // Container is stopped
        if (!$isPersistenceEnabled) {
            dockerNetworksLogger('Connect failed: container stopped, persistence disabled', ['containerId' => $containerId, 'containerRef' => $containerRef, 'state' => $containerState], 'user', 'error', 'exec');
            dockerNetworksSseEmitQueuedEvent($requestId, 'containerUpdate', [
                'type' => 'connect',
                'success' => false,
                'item' => ['id' => $containerId, 'name' => $containerNameHint !== '' ? $containerNameHint : $containerId],
                'message' => 'Container must be running to connect directly. Enable template XML persistence in Docker Networks settings to connect stopped containers.',
            ]);
            dockerNetworksRespond(['success' => false, 'error' => 'Container must be running to connect directly. Enable template XML persistence in Docker Networks settings to connect stopped containers.'], 400);
            return;
        }

        // Persistence is enabled; skip docker network connect and go straight to template update
        dockerNetworksLogger('Container is stopped, skipping direct connection (persistence enabled)', ['containerId' => $containerId, 'containerRef' => $containerRef, 'containerName' => $containerName, 'state' => $containerState], 'user', 'info', 'exec');

        $persist = dockerNetworksPersistNetworkAttachInTemplate($containerName, $networkName, true);
        
        if (!$persist['persisted']) {
            $message = $persist['warning'] ?: 'Failed to update template XML.';
            dockerNetworksLogger('Template persistence failed for stopped container', ['containerId' => $containerId, 'containerRef' => $containerRef, 'containerName' => $containerName], 'user', 'error', 'exec');
            dockerNetworksRespond(['success' => false, 'error' => $message], 500);
            return;
        }

        dockerNetworksLogger('Container template updated', ['containerId' => $containerId, 'containerRef' => $containerRef, 'containerName' => $containerName, 'networkName' => $networkName], 'user', 'info', 'exec');
        dockerNetworksSseEmitQueuedEvent($requestId, 'containerUpdate', [
            'type' => 'connect',
            'success' => true,
            'item' => ['id' => $containerId, 'name' => $containerName, 'scheduledOnly' => true, 'ipAddress' => 'pending'],
            'message' => 'Template updated—network will connect on startup',
        ]);
        dockerNetworksRespond(['success' => true, 'message' => 'Template updated—network will connect on startup', 'ipAddress' => 'pending', 'persisted' => true, 'warning' => 'This stopped container will join the network when it starts.']);
        return;
    }

    // Container is running; proceed with normal flow
    // Validate IP address if provided
    if ($ipAddress !== '') {
        $ipValidation = dockerNetworksValidateIpAddress($ipAddress);
        if (!$ipValidation['valid']) {
            dockerNetworksLogger('Connect container failed: invalid IP', ['ip' => $ipAddress, 'error' => $ipValidation['error']], 'user', 'error', 'exec');
            dockerNetworksRespond(['success' => false, 'error' => 'Invalid IP address: ' . $ipValidation['error']], 400);
            return;
        }

        // Check if IP is within subnet
        $network = dockerNetworksInspectNetwork($networkId);
        if (is_array($network) && isset($network['IPAM']) && is_array($network['IPAM'])) {
            $ipam = $network['IPAM'];
            if (isset($ipam['Config']) && is_array($ipam['Config']) && isset($ipam['Config'][0])) {
                $subnet = trim((string)$ipam['Config'][0]['Subnet']);
                if ($subnet !== '' && !dockerNetworksIpInSubnet($ipAddress, $subnet)) {
                    dockerNetworksLogger('Connect container failed: IP not in subnet', ['ip' => $ipAddress, 'subnet' => $subnet], 'user', 'error', 'exec');
                    dockerNetworksRespond(['success' => false, 'error' => 'IP address is not within network subnet (' . $subnet . ')'], 400);
                    return;
                }

                // Check if IP is already in use
                if (dockerNetworksIsIpInUse($ipAddress, $networkId)) {
                    dockerNetworksLogger('Connect container failed: IP already in use', ['ip' => $ipAddress], 'user', 'error', 'exec');
                    dockerNetworksRespond(['success' => false, 'error' => 'IP address is already in use on this network'], 409);
                    return;
                }
            }
        }
    }

    // Build docker network connect command
    $cmd = 'docker network connect';
    if ($ipAddress !== '') {
        $cmd .= ' --ip ' . escapeshellarg($ipAddress);
    }
    $cmd .= ' ' . escapeshellarg($networkId) . ' ' . escapeshellarg($containerRef);

    $result = dockerNetworksRun($cmd);

    if ($result['exitCode'] !== 0) {
        $daemonError = trim((string)($result['output'] ?? ''));
        $friendlyError = $daemonError !== '' ? $daemonError : 'Failed to connect container';
        $statusCode = 500;

        if (stripos($daemonError, 'sharing network namespace with another container or host') !== false) {
            $friendlyError = 'This container uses host/container network namespace mode, so Docker cannot attach additional networks. Change the container network mode to bridge/custom in the container template, then retry.';
            $statusCode = 409;
        }

        dockerNetworksLogger('Connect container failed', ['networkId' => $networkId, 'containerId' => $containerId, 'containerRef' => $containerRef, 'output' => $daemonError, 'friendlyError' => $friendlyError, 'statusCode' => $statusCode], 'user', 'error', 'exec');
        dockerNetworksSseEmitQueuedEvent($requestId, 'containerUpdate', [
            'type' => 'connect',
            'success' => false,
            'item' => ['id' => $containerId, 'name' => $containerName],
            'message' => $friendlyError,
        ]);
        dockerNetworksRespond(['success' => false, 'error' => $friendlyError], $statusCode);
        return;
    }

    $persist = dockerNetworksIsTemplatePersistenceEnabled()
        ? dockerNetworksPersistNetworkAttachInTemplate($containerName, $networkName, true)
        : [
            'persisted' => false,
            'warning' => 'Runtime network change applied. Template XML persistence is disabled in Docker Networks settings.',
        ];
    
    $assignedIp = $ipAddress;
    if ($assignedIp === '') {
        $assignedIp = dockerNetworksGetContainerNetworkIp($containerName, $networkId);
    }
    if ($assignedIp === '') {
        $assignedIp = dockerNetworksGetContainerNetworkIp($containerRef, $networkId);
    }
    if ($assignedIp === '') {
        $assignedIp = 'auto-assigned';
    }

    dockerNetworksLogger('Container connected', ['networkId' => $networkId, 'networkName' => $networkName, 'containerId' => $containerId, 'containerRef' => $containerRef, 'containerName' => $containerName, 'ipAddress' => $assignedIp, 'persisted' => $persist['persisted']], 'user', 'info', 'exec');
    dockerNetworksSseEmitQueuedEvent($requestId, 'containerUpdate', [
        'type' => 'connect',
        'success' => true,
        'item' => ['id' => $containerId, 'name' => $containerName, 'scheduledOnly' => false, 'ipAddress' => $assignedIp],
        'message' => 'Container connected to network',
    ]);

    dockerNetworksRespond([
        'success' => true,
        'message' => 'Container connected to network',
        'ipAddress' => $assignedIp,
        'persisted' => $persist['persisted'],
        'warning' => $persist['warning'],
    ]);
}


function dockerNetworksHandleDisconnectContainer(array $request): void
{
    $networkId = isset($request['networkId']) ? trim((string) $request['networkId']) : '';
    $containerId = isset($request['containerId']) ? trim((string) $request['containerId']) : '';
    $containerNameHint = isset($request['containerName']) ? trim((string) $request['containerName']) : '';
    $requestId = isset($request['requestId']) ? trim((string) $request['requestId']) : '';

    if ($networkId === '' || $containerId === '') {
        dockerNetworksRespond(['success' => false, 'error' => 'Network ID and Container ID are required'], 400);
        return;
    }

    $containerRef = $containerId;
    $containerName = dockerNetworksResolveContainerName($containerRef);
    if ($containerName === '' && $containerNameHint !== '') {
        $containerRef = $containerNameHint;
        $containerName = dockerNetworksResolveContainerName($containerRef);
    }

    if ($containerName === '') {
        dockerNetworksRespond(['success' => false, 'error' => 'Container not found (it may have been removed or renamed). Refresh and try again.'], 404);
        return;
    }

    $networkName = dockerNetworksResolveNetworkName($networkId);
    if ($networkName === '') {
        dockerNetworksRespond(['success' => false, 'error' => 'Network not found'], 404);
        return;
    }

    // Snapshot runtime connection state before disconnect.
    $currentIp = dockerNetworksGetContainerNetworkIp($containerRef, $networkId);
    $networkCount = dockerNetworksGetContainerNetworkCount($containerRef);
    $isOnlyNetwork = $networkCount <= 1;
    $isRuntimeConnected = dockerNetworksIsContainerConnectedToNetwork($containerRef, $networkId);
    $hasScheduledTemplateAttach = dockerNetworksCheckContainerScheduledNetwork($containerName, $networkName);

    if ($isRuntimeConnected) {
        $result = dockerNetworksRun('docker network disconnect ' . escapeshellarg($networkId) . ' ' . escapeshellarg($containerRef));

        if ($result['exitCode'] !== 0) {
            dockerNetworksLogger('Disconnect container failed', ['networkId' => $networkId, 'containerId' => $containerId, 'containerRef' => $containerRef, 'output' => $result['output']], 'user', 'error', 'exec');
            dockerNetworksSseEmitQueuedEvent($requestId, 'containerUpdate', [
                'type' => 'disconnect',
                'success' => false,
                'item' => ['id' => $containerId, 'name' => $containerName],
                'message' => $result['output'] ?: 'Failed to disconnect container',
            ]);
            dockerNetworksRespond(['success' => false, 'error' => $result['output'] ?: 'Failed to disconnect container'], 500);
            return;
        }
    }

    // Always remove scheduled template attach if it exists. This keeps runtime and template state aligned.
    $persist = [
        'persisted' => false,
        'warning' => '',
    ];
    if ($hasScheduledTemplateAttach || dockerNetworksIsTemplatePersistenceEnabled()) {
        $persist = dockerNetworksPersistNetworkAttachInTemplate($containerName, $networkName, false);
    }
    
    $warning = '';
    if ($isOnlyNetwork) {
        $warning = 'Warning: This was the container\'s only network attachment. It may now be unreachable.';
    }

    if (!$isRuntimeConnected && $hasScheduledTemplateAttach) {
        $warning = $persist['warning'] !== ''
            ? $persist['warning']
            : 'Scheduled network connection removed from template. The container will not auto-connect on startup.';
    }

    if (!$isRuntimeConnected && !$hasScheduledTemplateAttach) {
        $warning = 'Container was not connected to this network.';
    }

    dockerNetworksLogger('Container disconnected', ['networkId' => $networkId, 'networkName' => $networkName, 'containerId' => $containerId, 'containerRef' => $containerRef, 'containerName' => $containerName, 'ip' => $currentIp, 'wasOnlyNetwork' => $isOnlyNetwork, 'runtimeConnected' => $isRuntimeConnected, 'hadScheduledTemplateAttach' => $hasScheduledTemplateAttach, 'persisted' => $persist['persisted']], 'user', 'info', 'exec');
    dockerNetworksSseEmitQueuedEvent($requestId, 'containerUpdate', [
        'type' => 'disconnect',
        'success' => true,
        'item' => ['id' => $containerId, 'name' => $containerName],
        'message' => $isRuntimeConnected ? 'Container disconnected from network' : 'Scheduled network connection removed',
    ]);

    dockerNetworksRespond([
        'success' => true,
        'message' => $isRuntimeConnected ? 'Container disconnected from network' : 'Scheduled network connection removed',
        'containerName' => $containerName,
        'networkName' => $networkName,
        'wasOnlyNetwork' => $isOnlyNetwork,
        'runtimeDisconnected' => $isRuntimeConnected,
        'scheduledRemoved' => $hasScheduledTemplateAttach,
        'ip' => $currentIp,
        'persisted' => $persist['persisted'],
        'warning' => $persist['warning'] ?: $warning,
    ]);
}

function dockerNetworksHandleListContainers(): void
{
    $psCommand = dockerNetworksIsTemplatePersistenceEnabled()
        ? "docker ps -a --no-trunc --format='{{json .}}'"
        : "docker ps --no-trunc --format='{{json .}}'";

    $result = dockerNetworksRun($psCommand);
    if ($result['exitCode'] !== 0) {
        dockerNetworksRespond(['success' => false, 'error' => $result['output'] ?: 'Failed to list containers'], 500);
        return;
    }

    $containers = [];
    $lines = array_filter(explode("\n", (string) $result['output']));
    foreach ($lines as $line) {
        $row = json_decode($line, true);
        if (!is_array($row)) {
            continue;
        }

        $containers[] = [
            'id' => isset($row['ID']) ? (string) $row['ID'] : '',
            'name' => isset($row['Names']) ? (string) $row['Names'] : '',
            'image' => isset($row['Image']) ? (string) $row['Image'] : '',
            'state' => isset($row['State']) ? (string) $row['State'] : '',
            'status' => isset($row['Status']) ? (string) $row['Status'] : '',
        ];
    }

    usort($containers, static function (array $a, array $b): int {
        return strcmp($a['name'], $b['name']);
    });

    dockerNetworksRespond(['success' => true, 'containers' => $containers]);
}

function dockerNetworksResolveContainerName(string $containerId): string
{
    $container = dockerNetworksInspectContainer($containerId);
    if (!is_array($container) || !isset($container['Name'])) {
        return '';
    }

    return ltrim((string) $container['Name'], '/');
}

function dockerNetworksResolveContainerState(string $containerRef): string
{
    $container = dockerNetworksInspectContainer($containerRef);
    if (!is_array($container) || !isset($container['State']) || !is_array($container['State']) || !isset($container['State']['Status'])) {
        return '';
    }

    return strtolower(trim((string) $container['State']['Status']));
}

function dockerNetworksInspectContainer(string $containerRef): ?array
{
    $result = dockerNetworksRun('docker inspect ' . escapeshellarg($containerRef));
    if ($result['exitCode'] !== 0) {
        return null;
    }

    $decoded = json_decode((string) $result['output'], true);
    if (!is_array($decoded) || !isset($decoded[0]) || !is_array($decoded[0])) {
        return null;
    }

    return $decoded[0];
}

function dockerNetworksResolveNetworkName(string $networkId): string
{
    $network = dockerNetworksInspectNetwork($networkId);
    if (!is_array($network) || !isset($network['Name'])) {
        return '';
    }

    return trim((string) $network['Name']);
}

function dockerNetworksUserTemplatePath(string $containerName): string
{
    $dir = '/boot/config/plugins/dockerMan/templates-user';
    if (!is_dir($dir)) {
        return '';
    }

    $target = 'my-' . $containerName . '.xml';
    $targetLower = strtolower($target);
    $match = '';

    foreach (glob($dir . '/my-*.xml') ?: [] as $template) {
        $name = basename((string) $template);
        if ($name === $target) {
            return (string) $template;
        }
        if ($match === '' && strtolower($name) === $targetLower) {
            $match = (string) $template;
        }
    }

    return $match;
}

function dockerNetworksBuildTemplateConnectCmd(string $networkName, string $containerName): string
{
    return '&& docker network connect ' . $networkName . ' ' . $containerName;
}

function dockerNetworksBuildLegacyTemplateConnectCmd(string $networkName, string $containerName): string
{
    return '/usr/bin/docker network connect ' . escapeshellarg($networkName) . ' ' . escapeshellarg($containerName) . ' >/dev/null 2>&1 || true';
}

function dockerNetworksAppendPostArgsCommand(string $postArgs, string $command): string
{
    $trimmedPostArgs = trim($postArgs);
    if ($trimmedPostArgs === '') {
        return $command;
    }

    return rtrim($trimmedPostArgs) . ' ' . $command;
}

function dockerNetworksRemovePostArgsCommand(string $postArgs, string $command): string
{
    $pattern = '/\s*' . preg_quote($command, '/') . '(?=\s|$)/i';
    $updated = preg_replace($pattern, '', $postArgs);
    if (!is_string($updated)) {
        return trim($postArgs);
    }

    return trim(preg_replace('/\s+/', ' ', $updated) ?: '');
}

function dockerNetworksPersistNetworkAttachInTemplate(string $containerName, string $networkName, bool $attach): array
{
    $templatePath = dockerNetworksUserTemplatePath($containerName);
    if ($templatePath === '') {
        return [
            'persisted' => false,
            'warning' => 'Runtime network change applied, but no user template was found to persist this after Docker/server restart.',
        ];
    }

    $xml = @simplexml_load_file($templatePath);
    if ($xml === false) {
        return [
            'persisted' => false,
            'warning' => 'Runtime network change applied, but failed to load container template XML for persistence.',
        ];
    }

    $currentPostArgs = isset($xml->PostArgs) ? trim((string) $xml->PostArgs) : '';
    $managedCmd = dockerNetworksBuildTemplateConnectCmd($networkName, $containerName);
    $legacyCmd = dockerNetworksBuildLegacyTemplateConnectCmd($networkName, $containerName);

    $normalizedCurrent = strtolower(preg_replace('/\s+/', ' ', $currentPostArgs) ?: '');
    $normalizedManaged = strtolower(preg_replace('/\s+/', ' ', $managedCmd) ?: '');
    $normalizedLegacy = strtolower(preg_replace('/\s+/', ' ', $legacyCmd) ?: '');

    $newPostArgs = $currentPostArgs;
    if ($attach) {
        if (strpos($normalizedCurrent, $normalizedManaged) === false && strpos($normalizedCurrent, $normalizedLegacy) === false) {
            $newPostArgs = dockerNetworksAppendPostArgsCommand($currentPostArgs, $managedCmd);
        }
    } else {
        $newPostArgs = dockerNetworksRemovePostArgsCommand($currentPostArgs, $managedCmd);
        $newPostArgs = dockerNetworksRemovePostArgsCommand($newPostArgs, $legacyCmd);
    }

    if ($newPostArgs === $currentPostArgs) {
        return [
            'persisted' => true,
            'warning' => '',
        ];
    }

    $xml->PostArgs = $newPostArgs;

    $dom = new DOMDocument('1.0');
    $dom->preserveWhiteSpace = false;
    $dom->formatOutput = true;
    if (!$dom->loadXML((string) $xml->asXML())) {
        return [
            'persisted' => false,
            'warning' => 'Runtime network change applied, but failed to prepare updated container template XML.',
        ];
    }

    if (file_put_contents($templatePath, $dom->saveXML()) === false) {
        return [
            'persisted' => false,
            'warning' => 'Runtime network change applied, but failed to write container template XML for persistence.',
        ];
    }

    return [
        'persisted' => true,
        'warning' => '',
    ];
}
