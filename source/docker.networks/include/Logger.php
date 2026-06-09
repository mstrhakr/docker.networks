<?php

declare(strict_types=1);

if (!function_exists('dockerNetworksLoadCfg')) {
    function dockerNetworksLoadCfg(): array
    {
        $cfgPath = '/boot/config/plugins/docker.networks/docker.networks.cfg';
        if (!is_file($cfgPath)) {
            return [];
        }

        // parse_ini_file on PHP 7+ does not support '#' comments (only ';').
        // Strip '#' comment lines before parsing so a legacy cfg does not cause
        // a fatal ini syntax error that poisons the JSON response.
        $raw = file_get_contents($cfgPath);
        if ($raw !== false) {
            $sanitized = preg_replace('/^#[^\n]*(\n|$)/m', '', (string)$raw);
            $cfg = @parse_ini_string((string)$sanitized, false, INI_SCANNER_RAW);
            if (is_array($cfg)) {
                return $cfg;
            }
        }

        $cfg = @parse_ini_file($cfgPath, false, INI_SCANNER_RAW);
        return is_array($cfg) ? $cfg : [];
    }
}

if (!function_exists('dockerNetworksShouldLogApiCalls')) {
    function dockerNetworksShouldLogApiCalls(): bool
    {
        $cfg = dockerNetworksLoadCfg();
        return (($cfg['LOG_API_CALLS'] ?? '0') === '1') || (($cfg['LOG_API_CALLS'] ?? 'false') === 'true');
    }
}

if (!function_exists('dockerNetworksLogger')) {
    function dockerNetworksLogger(string $message, $data = null, string $type = 'user', string $level = 'info', string $category = ''): void
    {
        $cfg = dockerNetworksLoadCfg();
        $debugMode = (($cfg['DEBUG_TO_LOG'] ?? 'false') === 'true');

        if (!$debugMode && $level === 'debug') {
            return;
        }

        $displayLevel = '[INFO]';
        $priority = $type . '.info';

        switch ($level) {
            case 'debug':
                $displayLevel = '[DEBUG]';
                $priority = $type . '.debug';
                break;
            case 'error':
            case 'err':
                $displayLevel = '[ERROR]';
                $priority = $type . '.err';
                break;
            case 'warning':
            case 'warn':
                $displayLevel = '[WARN]';
                $priority = $type . '.warning';
                break;
        }

        $category = trim($category);
        if ($category !== '') {
            $category = preg_replace('/[^A-Za-z0-9_.-]+/', '-', $category) ?? '';
            $category = trim($category, '-');
        }

        $parts = [];
        $parts[] = $debugMode ? '[' . $priority . ']' : $displayLevel;
        if ($category !== '') {
            $parts[] = '[' . $category . ']';
        }
        $parts[] = $message;

        if ($data !== null && $data !== '' && $data !== 'null') {
            if (is_array($data) || is_object($data)) {
                $encoded = json_encode($data);
                $data = $encoded !== false ? $encoded : '[json-encode-failed]';
            }
            $parts[] = '- Data: ' . (string) $data;
        }

        $formatted = implode(' ', $parts);
        exec("logger -t 'docker.networks' -p " . escapeshellarg($priority) . ' ' . escapeshellarg($formatted));
    }
}
