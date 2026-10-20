<?php

declare(strict_types=1);

require_once __DIR__ . '/../source/docker.networks/include/ExecFunctions.php';

function checkPersistence(bool $condition, string $message): void
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}

foreach (['' => false, 'unknown' => false, '6.12.0' => false, '7.3.2' => false,
    '7.4.0-beta.0.1' => false, '7.4.0-beta.1' => false, '7.4.0-beta.1.1' => false,
    '7.4.0-beta.1.2' => true, '7.4.0-beta.2' => true, '7.4.0-rc.1' => true,
    '7.4.0' => true, '7.4.1' => true, '8.0.0' => true] as $version => $supported) {
    checkPersistence(dockerNetworksSupportsExtraNetworks($version) === $supported, 'Version gate: ' . $version);
}

foreach (['docker-socket-proxy' => true, 'service_1.test' => true, 'Docker-Socket-Proxy' => false,
    'Docker Socket Proxy' => false, 'comma,name' => false, '-leading' => false, 'name-' => true] as $name => $supported) {
    checkPersistence(dockerNetworksIsSupportedNetworkName($name) === $supported, 'Network name validation: ' . $name);
}
checkPersistence(dockerNetworksSuggestSupportedNetworkName(' Docker Socket Proxy ') === 'docker-socket-proxy', 'Suggest lowercase hyphenated name');
checkPersistence(dockerNetworksSuggestSupportedNetworkName('Proxy__LAN') === 'proxy__lan', 'Preserve supported underscores');
checkPersistence(dockerNetworksSuggestSupportedNetworkName(' -- ') === '', 'Reject empty suggestion');

$xml = simplexml_load_string('<Container><Name>example</Name><Network>primary</Network><ExtraNetworks>one,two one</ExtraNetworks><PostArgs>app  --flag &amp;&amp; docker network connect one example</PostArgs><ExtraParams>--cpus=2</ExtraParams></Container>');
checkPersistence($xml !== false, 'Fixture XML');
$postArgs = (string) $xml->PostArgs;
dockerNetworksUpdateExtraNetworks($xml, 'three', true);
dockerNetworksUpdateExtraNetworks($xml, 'three', true);
checkPersistence(dockerNetworksExtraNetworks($xml) === ['one', 'two', 'three'], 'Deduplicate attachments');
dockerNetworksUpdateExtraNetworks($xml, 'one', false);
dockerNetworksUpdateExtraNetworks($xml, 'primary', true);
checkPersistence(dockerNetworksExtraNetworks($xml) === ['two', 'three'], 'Detach and exclude primary');
checkPersistence((string) $xml->PostArgs === $postArgs, 'Preserve all Post Arguments');
checkPersistence((string) $xml->ExtraParams === '--cpus=2', 'Preserve unrelated fields');
dockerNetworksUpdateExtraNetworks($xml, 'two', false);
dockerNetworksUpdateExtraNetworks($xml, 'three', false);
checkPersistence(dockerNetworksExtraNetworks($xml) === [], 'Remove final attachment');
$empty = simplexml_load_string('<Container><Network>primary</Network></Container>');
checkPersistence($empty !== false, 'Empty template fixture');
dockerNetworksUpdateExtraNetworks($empty, 'new', true);
checkPersistence(dockerNetworksExtraNetworks($empty) === ['new'], 'Create missing ExtraNetworks');
checkPersistence(!isset($empty->PostArgs), 'Do not create Post Arguments');

foreach (['&& docker network connect one example', '/usr/bin/docker network connect \'one\' \'example\' >/dev/null 2>&1 || true', 'docker network connect --ip 172.20.0.5 one example'] as $command) {
    checkPersistence(dockerNetworksHasLegacyNetworkCommands($command), 'Detect reconnect command');
}
checkPersistence(!dockerNetworksHasLegacyNetworkCommands('app --flag'), 'Ordinary Post Arguments');

$directory = sys_get_temp_dir() . '/docker-networks-tests-' . bin2hex(random_bytes(6));
checkPersistence(mkdir($directory, 0700), 'Create isolated fixture directory');
try {
    $legacy = '<Container><Name>legacy</Name><PostArgs>&amp;&amp; docker network connect one legacy</PostArgs></Container>';
    file_put_contents($directory . '/my-legacy.xml', $legacy);
    file_put_contents($directory . '/my-native.xml', '<Container><Name>native</Name><Network>primary</Network><ExtraNetworks>one,two,primary</ExtraNetworks><PostArgs>app --flag</PostArgs></Container>');
    checkPersistence(dockerNetworksLegacyNetworkContainers($directory) === ['legacy'], 'Read-only legacy detection');
    checkPersistence(file_get_contents($directory . '/my-legacy.xml') === $legacy, 'Detection never rewrites templates');
    checkPersistence(dockerNetworksBuildScheduledNetworkCounts(['one' => ['native']], $directory) === ['two' => 1], 'Pending excludes live attachments, primary, and legacy commands');
} finally {
    foreach (glob($directory . '/*') ?: [] as $path) {
        unlink($path);
    }
    rmdir($directory);
}

if (!dockerNetworksSupportsExtraNetworks()) {
    foreach (['dockerNetworksHandleConnectContainer', 'dockerNetworksHandleDisconnectContainer'] as $handler) {
        ob_start();
        $handler([]);
        $response = json_decode((string) ob_get_clean(), true);
        checkPersistence(http_response_code() === 403 && $response['success'] === false, 'Block unsupported mutation before Docker');
    }
    checkPersistence(!dockerNetworksPersistNetworkAttachInTemplate('example', 'one', true)['persisted'], 'Block unsupported template writes');
}

echo "Template persistence regression checks passed.\n";