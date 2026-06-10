<?php
$docroot = $docroot ?? ($_SERVER['DOCUMENT_ROOT'] ?: '/usr/local/emhttp');
require_once __DIR__ . '/Logger.php';

function dockerNetworksNormalizeCfgValue(string $value): string
{
  return strtolower(trim($value, " \t\n\r\0\x0B\"'"));
}

function dockerNetworksCfgBool(array $cfg, string $key, bool $default = false): bool
{
  if (!isset($cfg[$key])) {
    return $default;
  }

  $value = dockerNetworksNormalizeCfgValue((string)$cfg[$key]);
  return in_array($value, ['1', 'true', 'yes', 'on', 'preserve', 'enabled'], true);
}

// Plugin settings: use Unraid-idiomatic parse_plugin_cfg (merges default.cfg + user cfg,
// strips # comments, same behaviour as the rest of the Unraid framework).
$cfg = function_exists('parse_plugin_cfg') ? ((array)(parse_plugin_cfg('docker.networks') ?: [])) : [];

$refreshInterval = isset($cfg['REFRESH_INTERVAL']) ? (int)$cfg['REFRESH_INTERVAL'] : 30;
if ($refreshInterval <= 0) {
    $refreshInterval = 30;
}
$xmlTemplatePersist = dockerNetworksCfgBool($cfg, 'XML_TEMPLATE_PERSIST', false);

// Docker settings: mirror DockerClient.php — merge dynamix.docker.manager defaults with
// the live docker.cfg so the result is identical to what Unraid itself sees.
$dockerCfgDefaults = function_exists('my_parse_ini_file')
    ? ((array)(@my_parse_ini_file("$docroot/plugins/dynamix.docker.manager/default.cfg") ?: []))
    : [];
$dockerCfgLive = function_exists('my_parse_ini_file')
    ? ((array)(@my_parse_ini_file('/boot/config/docker.cfg') ?: []))
    : [];
$dockerCfg = array_replace_recursive($dockerCfgDefaults, $dockerCfgLive);
$userNetworksPersist = (($dockerCfg['DOCKER_USER_NETWORKS'] ?? 'remove') === 'preserve');

if (function_exists('dockerNetworksLogger')) {
  dockerNetworksLogger('Page settings snapshot', [
    'pluginCfgPath' => '/boot/config/plugins/docker.networks/docker.networks.cfg',
    'pluginCfg' => [
      'REFRESH_INTERVAL' => $cfg['REFRESH_INTERVAL'] ?? null,
      'XML_TEMPLATE_PERSIST' => $cfg['XML_TEMPLATE_PERSIST'] ?? null,
    ],
    'dockerDefaultsPath' => "$docroot/plugins/dynamix.docker.manager/default.cfg",
    'dockerCfgPath' => '/boot/config/docker.cfg',
    'dockerCfg' => [
      'DOCKER_USER_NETWORKS' => $dockerCfg['DOCKER_USER_NETWORKS'] ?? null,
    ],
    'derived' => [
      'refreshInterval' => $refreshInterval,
      'userNetworksPersist' => $userNetworksPersist,
      'xmlTemplatePersist' => $xmlTemplatePersist,
    ],
  ], 'daemon', 'debug', 'settings');
}
?>
<script>
window.dockerNetworksApiUrl = '/plugins/docker.networks/include/Exec.php';
window.dockerNetworksRefreshInterval = <?= (int)$refreshInterval ?>;
window.dockerNetworksUserNetworksPersist = <?= $userNetworksPersist ? 'true' : 'false' ?>;
window.dockerNetworksXmlTemplatePersist = <?= $xmlTemplatePersist ? 'true' : 'false' ?>;
window.dockerNetworksSettingsUrl = '/Settings/DockerSettings';
window.dockerNetworksPluginSettingsUrl = '/Settings/docker.networks.settings';
</script>

<div id="docker-networks-page">
<div class="alert alert-success" id="successMsg" style="display:none;"></div>
<div class="alert alert-error" id="errorMsg" style="display:none;"></div>
<div class="alert" id="dockerUserNetworksWarning" style="display:none;"></div>
<div class="alert" id="dockerTemplatePersistenceWarning" style="display:none;"></div>

<div class="docker-networks-actions">
  <button class="button orange-button" id="btnCreateNetwork" type="button">+ Create Network</button>
  <button class="button orange-button" id="btnRefreshNetworks" type="button">Refresh</button>
  <button class="button" id="btnPluginSettings" type="button">Settings</button>
</div>

<div class="loading" id="loading">
  <div class="docker-networks-spinner"></div>
  <p>Loading networks...</p>
</div>

<table id="networksTable" style="display:none;">
  <thead>
    <tr>
      <th>Network Name</th>
      <th>Driver</th>
      <th>Subnet</th>
      <th>Containers</th>
      <th>Actions</th>
    </tr>
  </thead>
  <tbody id="networksBody"></tbody>
</table>

<div id="createModal" class="modal">
  <div class="modal-content">
    <div class="modal-header">
      <h2>Create New Docker Network</h2>
      <span class="close" id="closeCreateModal">&times;</span>
    </div>
    <form id="createNetworkForm">
      <div class="form-group">
        <label for="networkName">Network Name:</label>
        <input type="text" id="networkName" name="networkName" required>
      </div>
      <div class="form-group">
        <label for="networkDriver">Driver:</label>
        <select id="networkDriver" name="networkDriver">
          <option value="bridge">bridge (default)</option>
          <option value="host">host</option>
          <option value="overlay">overlay</option>
        </select>
      </div>
      <div class="form-group">
        <label for="networkSubnet">Subnet (optional):</label>
        <input type="text" id="networkSubnet" name="networkSubnet" placeholder="e.g., 172.20.0.0/16">
      </div>
      <button type="submit" class="button orange-button">Create</button>
      <button type="button" class="button" id="btnCancelCreate">Cancel</button>
    </form>
  </div>
</div>

<div id="editModal" class="modal">
  <div class="modal-content">
    <div class="modal-header">
      <h2>Edit Network</h2>
      <span class="close" id="closeEditModal">&times;</span>
    </div>
    <form id="editNetworkForm">
      <input type="hidden" id="editNetworkId">
      <div class="form-group">
        <label>Network Name:</label>
        <p id="editNetworkName"></p>
      </div>
      <div class="form-group">
        <label>Driver:</label>
        <p id="editNetworkDriver"></p>
      </div>
      <div class="form-group">
        <label for="editNetworkDesc">Description:</label>
        <input type="text" id="editNetworkDesc" name="description" placeholder="Optional description">
      </div>
      <button type="submit" class="button orange-button">Save</button>
      <button type="button" class="button" id="btnCancelEdit">Cancel</button>
    </form>
  </div>
</div>

<div id="manageModal" class="modal">
  <div class="modal-content modal-wide manage-modal-content">
    <div class="modal-header">
      <h2>Manage Network Attachments</h2>
      <span class="close" id="closeManageModal">&times;</span>
    </div>

    <div class="form-group">
      <label>Network:</label>
      <p id="manageNetworkName"></p>
    </div>

    <div class="form-group">
      <label for="connectContainerSelect">Attach Container:</label>
      <select id="connectContainerSelect" name="connectContainerSelect"></select>
    </div>

    <div class="form-group">
      <label for="connectContainerIpInput">IP Address (Optional):</label>
      <input type="text" id="connectContainerIpInput" name="connectContainerIpInput" placeholder="Leave blank for auto-assignment" />
      <small style="display: block; margin-top: 5px; color: #666;">Format: xxx.xxx.xxx.xxx (must be within network subnet)</small>
      <div style="margin-top:10px;">
        <button type="button" class="button orange-button" id="btnConnectContainer">Connect</button>
      </div>
    </div>

    <div class="loading manage-loading" id="manageLoading">
      <div class="docker-networks-spinner"></div>
      <p>Loading network attachments...</p>
    </div>

    <h3>Connected Containers</h3>
    <div class="manage-table-wrap" id="manageTableWrap">
      <table id="connectedContainersTable" class="small-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Container ID</th>
            <th>Address</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="connectedContainersBody"></tbody>
      </table>
    </div>

    <div style="margin-top:15px;">
      <button type="button" class="button" id="btnCloseManage">Close</button>
    </div>
  </div>
</div>
</div>
