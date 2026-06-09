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
        dockerNetworksLogger('API action request', ['action' => $action], 'daemon', 'info', 'api');
    }

    switch ($action) {
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
        default:
            dockerNetworksRespond(['success' => false, 'error' => 'Invalid action'], 400);
            return;
    }
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

    $decoded = json_decode((string) file_get_contents($path), true);
    return is_array($decoded) ? $decoded : [];
}

function dockerNetworksSaveMeta(array $meta): bool
{
    $path = dockerNetworksMetaPath();
    $dir = dirname($path);
    if (!is_dir($dir) && !@mkdir($dir, 0777, true) && !is_dir($dir)) {
        return false;
    }

    return file_put_contents($path, json_encode($meta, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)) !== false;
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
        dockerNetworksLogger('Delete network failed', ['id' => $id, 'output' => $result['output']], 'user', 'error', 'exec');
        dockerNetworksRespond(['success' => false, 'error' => $result['output'] ?: 'Failed to delete network'], 500);
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

function dockerNetworksHandleConnectContainer(array $request): void
{
    $networkId = isset($request['networkId']) ? trim((string) $request['networkId']) : '';
    $containerId = isset($request['containerId']) ? trim((string) $request['containerId']) : '';

    if ($networkId === '' || $containerId === '') {
        dockerNetworksRespond(['success' => false, 'error' => 'Network ID and Container ID are required'], 400);
        return;
    }

    $result = dockerNetworksRun('docker network connect ' . escapeshellarg($networkId) . ' ' . escapeshellarg($containerId));

    if ($result['exitCode'] !== 0) {
        dockerNetworksLogger('Connect container failed', ['networkId' => $networkId, 'containerId' => $containerId, 'output' => $result['output']], 'user', 'error', 'exec');
        dockerNetworksRespond(['success' => false, 'error' => $result['output'] ?: 'Failed to connect container'], 500);
        return;
    }

    dockerNetworksLogger('Container connected', ['networkId' => $networkId, 'containerId' => $containerId], 'user', 'info', 'exec');
    dockerNetworksRespond(['success' => true, 'message' => 'Container connected to network']);
}

function dockerNetworksHandleDisconnectContainer(array $request): void
{
    $networkId = isset($request['networkId']) ? trim((string) $request['networkId']) : '';
    $containerId = isset($request['containerId']) ? trim((string) $request['containerId']) : '';

    if ($networkId === '' || $containerId === '') {
        dockerNetworksRespond(['success' => false, 'error' => 'Network ID and Container ID are required'], 400);
        return;
    }

    $result = dockerNetworksRun('docker network disconnect ' . escapeshellarg($networkId) . ' ' . escapeshellarg($containerId));

    if ($result['exitCode'] !== 0) {
        dockerNetworksLogger('Disconnect container failed', ['networkId' => $networkId, 'containerId' => $containerId, 'output' => $result['output']], 'user', 'error', 'exec');
        dockerNetworksRespond(['success' => false, 'error' => $result['output'] ?: 'Failed to disconnect container'], 500);
        return;
    }

    dockerNetworksLogger('Container disconnected', ['networkId' => $networkId, 'containerId' => $containerId], 'user', 'info', 'exec');
    dockerNetworksRespond(['success' => true, 'message' => 'Container disconnected from network']);
}

function dockerNetworksHandleListContainers(): void
{
    $result = dockerNetworksRun("docker ps -a --format='{{json .}}'");
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
