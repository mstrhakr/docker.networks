(function () {
  'use strict';

  var apiBase = window.dockerNetworksApiUrl || '/plugins/docker.networks/include/Exec.php';
  var refreshMs = (window.dockerNetworksRefreshInterval || 30) * 1000;
  var userNetworksPersist = false;
  var xmlTemplatePersist = false;
  var dockerSettingsUrl = window.dockerNetworksSettingsUrl || '/Settings/DockerSettings';
  var pluginSettingsUrl = window.dockerNetworksPluginSettingsUrl || '/Settings/docker.networks.settings';
  var allContainers = [];
  var currentNetwork = null;
  var networksById = {};

  function networkKey(net) {
    if (!net) {
      return '';
    }
    return net.Id || net.Name || '';
  }

  function networkSubnet(net) {
    if (net && net.IPAM && Array.isArray(net.IPAM.Config) && net.IPAM.Config[0] && net.IPAM.Config[0].Subnet) {
      return net.IPAM.Config[0].Subnet;
    }
    return 'N/A';
  }

  function networkContainerCount(net) {
    return Object.keys((net && net.Containers) || {}).length;
  }

  function networkSignature(net) {
    return JSON.stringify({
      name: net && net.Name,
      id: net && net.Id,
      driver: net && net.Driver,
      subnet: networkSubnet(net),
      description: net && net.Description,
      containerCount: networkContainerCount(net),
      isDefault: !!(net && net.IsDefault),
      isProtected: !!(net && net.IsProtected),
      protectionLabel: net && net.ProtectionLabel
    });
  }

  function showMessage(msg, isError) {
    if (isError) {
      $('#errorMsg').text(msg).show();
      $('#successMsg').hide();
      setTimeout(function () { $('#errorMsg').fadeOut(); }, 5000);
    } else {
      $('#successMsg').text(msg).show();
      $('#errorMsg').hide();
      setTimeout(function () { $('#successMsg').fadeOut(); }, 5000);
    }
  }

  function ensureDismissibleBanner(selector) {
    var banner = $(selector);
    if (!banner.length || banner.data('dismissibleInit')) {
      return banner;
    }

    banner.addClass('dn-banner');
    var message = $('<div class="dn-banner-message"></div>');
    var close = $('<button type="button" class="dn-banner-close" aria-label="Close">&times;</button>');

    close.on('click', function () {
      banner.data('dismissed', true).hide();
    });

    banner.empty().append(message).append(close);
    banner.data('dismissibleInit', true);
    return banner;
  }

  function showBanner(selector, html) {
    var banner = ensureDismissibleBanner(selector);
    if (!banner.length || banner.data('dismissed')) {
      return;
    }
    banner.find('.dn-banner-message').html(html);
    banner.show();
  }

  function hideBanner(selector) {
    var banner = $(selector);
    banner.hide();
  }

  function updateUserNetworksWarning() {
    if (userNetworksPersist) {
      logClient('User networks banner hidden', { userNetworksPersist: userNetworksPersist }, 'info', 'settings');
      hideBanner('#dockerUserNetworksWarning');
      return;
    }

    logClient('User networks banner shown', { userNetworksPersist: userNetworksPersist }, 'info', 'settings');
    showBanner('#dockerUserNetworksWarning', 'Docker setting <strong>"Preserve user defined networks"</strong> is currently disabled. Connections may be lost when Docker/server restarts. <a href="' + escapeHtml(dockerSettingsUrl) + '">Open Docker Settings</a> to enable it.');
  }

  function updateTemplatePersistenceWarning() {
    if (xmlTemplatePersist) {
      logClient('Template persistence banner hidden', { xmlTemplatePersist: xmlTemplatePersist }, 'info', 'settings');
      hideBanner('#dockerTemplatePersistenceWarning');
      return;
    }

    logClient('Template persistence banner shown', { xmlTemplatePersist: xmlTemplatePersist }, 'info', 'settings');
    showBanner('#dockerTemplatePersistenceWarning', 'Template XML persistence is <strong>disabled</strong>. Network changes apply at runtime only. Enable it explicitly in <a href="' + escapeHtml(pluginSettingsUrl) + '">Docker Networks Settings</a> if you want template edits for restart persistence.');
  }

  function logClient(msg, data, level, category) {
    if (typeof window.dockerNetworksLogger === 'function') {
      window.dockerNetworksLogger(msg, data, 'user', level || 'info', category || 'ui');
    }
  }

  function syncBannerSettings() {
    userNetworksPersist = !!window.dockerNetworksUserNetworksPersist;
    xmlTemplatePersist = !!window.dockerNetworksXmlTemplatePersist;
  }

  function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  /**
   * Validate IPv4 address format
   */
  function validateIpAddress(ip) {
    if (ip === '' || ip === null) {
      return { valid: true, error: '' }; // empty is OK (auto-assign)
    }

    // IPv4 validation regex
    var ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    var match = String(ip).trim().match(ipv4Regex);
    if (!match) {
      return { valid: false, error: 'Invalid IP address format' };
    }

    // Validate each octet is 0-255
    for (var i = 1; i <= 4; i++) {
      var octet = parseInt(match[i], 10);
      if (octet < 0 || octet > 255) {
        return { valid: false, error: 'IP octets must be between 0 and 255' };
      }
    }

    return { valid: true, error: '' };
  }


  function apiCall(action, payload, onSuccess) {
    var requestBody = payload || {};
    requestBody.action = action;

    $.post(apiBase, requestBody, onSuccess, 'json').fail(function (xhr, status, error) {
      logClient('API call failed', { action: action, status: status, error: error, response: xhr && xhr.responseText ? xhr.responseText : '' }, 'error', 'api');
      showActionResult('API Error', '<div class="swal-text-block">Error: ' + escapeHtml(error) + '</div>', false);
    });
  }

  function requestData(action, payload) {
    return new Promise(function (resolve, reject) {
      apiCall(action, payload, function (data) {
        if (data && data.success) {
          resolve(data);
          return;
        }
        reject((data && data.error) || 'Unknown error');
      });
    });
  }

  function createActionButton(label, classes, handler, disabled) {
    var button = $('<button type="button"></button>');
    button.addClass(classes);
    button.text(label);
    if (disabled) {
      button.prop('disabled', true).attr('title', 'Protected Docker networks cannot be deleted');
      return button;
    }
    button.on('click', handler);
    return button;
  }

  function confirmAction(title, messageHtml, confirmText, onConfirm) {
    if (typeof swal === 'function') {
      swal({
        title: title,
        text: messageHtml,
        html: true,
        type: 'warning',
        showCancelButton: true,
        confirmButtonText: confirmText,
        cancelButtonText: 'Cancel'
      }, function (confirmed) {
        if (confirmed) {
          onConfirm();
        }
      });
      return;
    }

    if (confirm($('<div>').html(messageHtml).text())) {
      onConfirm();
    }
  }

  function showActionResult(title, messageHtml, isSuccess, onClose) {
    if (typeof swal === 'function') {
      swal({
        title: title,
        text: messageHtml,
        html: true,
        type: isSuccess ? 'success' : 'error',
        confirmButtonText: 'OK'
      }, function () {
        if (onClose) {
          onClose();
        }
      });
      return;
    }

    alert($('<div>').html(messageHtml).text());
    if (onClose) {
      onClose();
    }
  }

  function showLoadingModal(title, messageHtml) {
    if (typeof swal === 'function') {
      swal({
        title: title,
        text: messageHtml,
        html: true,
        type: 'info',
        allowOutsideClick: false,
        allowEscapeKey: false,
        didOpen: function (swalInstance) {
          swalInstance.hideConfirmButton();
          var loading = document.createElement('div');
          loading.className = 'docker-networks-spinner';
          swalInstance.appendChild(loading);
        }
      });
      return;
    }
  }

  function closeModal() {
    if (typeof swal === 'function') {
      swal.close();
    }
  }

  function renderNetworkRow(row, net) {
    var key = networkKey(net);
    var nameHtml = '<strong class="network-name">' + escapeHtml(net.Name || '') + '</strong>';

    if (net.IsProtected) {
      nameHtml += ' <span class="network-badge">' + escapeHtml(net.ProtectionLabel || 'Protected') + '</span>';
    }

    nameHtml += '<br><span class="network-id">' + escapeHtml((net.Id || '').substring(0, 12)) + '</span>';

    if (net.Description) {
      nameHtml += '<br><span class="network-desc">' + escapeHtml(net.Description) + '</span>';
    }

    row.attr('data-network-id', key);
    row.attr('data-network-signature', networkSignature(net));
    row.empty();

    row.append($('<td></td>').html(nameHtml));
    row.append($('<td></td>').text(net.Driver || ''));
    row.append($('<td></td>').text(networkSubnet(net)));
    row.append($('<td></td>').text(String(networkContainerCount(net))));

    var actions = $('<td class="network-actions"></td>');
    actions.append(createActionButton('Edit', 'button', function () { openEditModal(net); }));
    actions.append(createActionButton('Manage', 'button', function () { openManageModal(net); }));
    actions.append(createActionButton('Delete', 'button orange-button', function () { deleteNetwork(net.Id, net.Name, !!net.IsProtected, net.ProtectionLabel); }, !!net.IsProtected));

    row.append(actions);
  }

  function syncNetworksTable(networks) {
    var tbody = $('#networksBody');
    networksById = {};

    if (!networks || networks.length === 0) {
      tbody.empty();
      tbody.html('<tr><td colspan="5" style="text-align:center;">No networks found</td></tr>');
      return;
    }

    tbody.find('tr[data-network-empty="true"]').remove();

    var existingRows = {};
    tbody.find('tr[data-network-id]').each(function () {
      var row = $(this);
      existingRows[row.attr('data-network-id')] = row;
    });

    var seen = {};

    networks.forEach(function (net) {
      var key = networkKey(net);
      if (!key) {
        return;
      }

      networksById[key] = net;
      seen[key] = true;

      var row = existingRows[key];
      var signature = networkSignature(net);
      if (!row || !row.length) {
        row = $('<tr></tr>');
        renderNetworkRow(row, net);
        tbody.append(row);
        return;
      }

      if (row.attr('data-network-signature') !== signature) {
        renderNetworkRow(row, net);
      }

      tbody.append(row);
    });

    Object.keys(existingRows).forEach(function (key) {
      if (!seen[key]) {
        existingRows[key].remove();
      }
    });
  }

  function loadContainers() {
    return requestData('containers', {}).then(function (data) {
      allContainers = data.containers || [];
      logClient('Containers loaded', { count: allContainers.length }, 'debug', 'api');
    }).catch(function (err) {
      allContainers = [];
      logClient('Load containers failed', { error: String(err) }, 'error', 'api');
      showActionResult('Load Failed', '<div class="swal-text-block">Unable to load containers: ' + escapeHtml(String(err)) + '</div>', false);
    });
  }

  function refreshManageModal() {
    if (!currentNetwork) {
      return;
    }

    var refreshedNetwork = networksById[networkKey(currentNetwork)];
    if (!refreshedNetwork) {
      closeManageModal();
      return;
    }

    currentNetwork = refreshedNetwork;
    $('#manageNetworkName').text((refreshedNetwork.Name || '') + ' (' + (refreshedNetwork.Id || '').substring(0, 12) + ')');
    renderConnectedContainers(refreshedNetwork);
    renderConnectSelect(refreshedNetwork);
  }

  function loadNetworks(options) {
    var settings = $.extend({ showLoading: false, refreshContainers: false }, options || {});

    if (settings.showLoading) {
      $('#loading').show();
      $('#networksTable').hide();
    }

    var tasks = [requestData('list', {})];
    if (settings.refreshContainers) {
      tasks.unshift(loadContainers());
    }

    return Promise.all(tasks).then(function (results) {
      var data = results[results.length - 1];
      syncNetworksTable(data.networks || []);
      $('#networksTable').show();
      refreshManageModal();
      return data;
    }).catch(function (err) {
      logClient('Load networks failed', { error: String(err) }, 'error', 'api');
      showActionResult('Load Failed', '<div class="swal-text-block">' + escapeHtml(String(err)) + '</div>', false);
      throw err;
    }).finally(function () {
      if (settings.showLoading) {
        $('#loading').hide();
      }
    });
  }

  function openCreateModal() {
    $('#createNetworkForm')[0].reset();
    $('#createModal').show();
  }

  function closeCreateModal() {
    $('#createModal').hide();
  }

  function openEditModal(network) {
    $('#editNetworkId').val(network.Id || '');
    $('#editNetworkName').text(network.Name || '');
    $('#editNetworkDriver').text(network.Driver || '');
    $('#editNetworkDesc').val(network.Description || '');
    $('#editModal').show();
  }

  function closeEditModal() {
    $('#editModal').hide();
  }

  function openManageModal(network) {
    currentNetwork = network;
    $('#manageNetworkName').text((network.Name || '') + ' (' + (network.Id || '').substring(0, 12) + ')');
    setManageLoading(true);
    $('#manageModal').show();

    loadContainers().then(function () {
      renderConnectedContainers(currentNetwork || network);
      renderConnectSelect(currentNetwork || network);
    }).finally(function () {
      setManageLoading(false);
    });
  }

  function closeManageModal() {
    currentNetwork = null;
    $('#manageModal').hide();
    setManageLoading(false);
  }

  function setManageLoading(isLoading) {
    var loading = !!isLoading;
    $('#manageLoading').toggle(loading);
    $('#manageTableWrap').toggle(!loading);
    $('#btnConnectContainer').prop('disabled', loading);
    $('#connectContainerSelect').prop('disabled', loading);
  }

  function connectedContainerList(network) {
    var map = (network && network.Containers) || {};
    return Object.keys(map).map(function (key) {
      var c = map[key] || {};
      return {
        id: c.Name || key,
        endpointId: key,
        name: c.Name || key,
        ipv4: c.IPv4Address || '',
        ipv6: c.IPv6Address || ''
      };
    }).sort(function (a, b) {
      return a.name.localeCompare(b.name);
    });
  }

  function renderConnectedContainers(network) {
    var rows = connectedContainerList(network);
    var tbody = $('#connectedContainersBody');
    tbody.empty();

    if (!rows.length) {
      tbody.html('<tr><td colspan="4" style="text-align:center;">No containers attached</td></tr>');
      return;
    }

    rows.forEach(function (item) {
      var tr = $('<tr></tr>');
      tr.append('<td>' + escapeHtml(item.name) + '</td>');
      tr.append('<td>' + escapeHtml(item.id) + '</td>');
      tr.append('<td>' + escapeHtml(item.ipv4 || item.ipv6 || 'N/A') + '</td>');

      var actionTd = $('<td></td>');
      var disconnectBtn = $('<button type="button" class="button docker-networks-danger-button">Disconnect</button>');
      disconnectBtn.on('click', function () {
        disconnectContainer(item.id, item.name);
      });
      actionTd.append(disconnectBtn);
      tr.append(actionTd);
      tbody.append(tr);
    });
  }

  function renderConnectSelect(network) {
    var connected = {};
    connectedContainerList(network).forEach(function (item) {
      connected[item.id] = true;
      connected[item.name] = true;
    });

    var select = $('#connectContainerSelect');
    select.empty();
    select.append('<option value="">Select a container...</option>');

    allContainers.forEach(function (container) {
      if (!container || !container.id || !container.name) {
        return;
      }
      if (connected[container.id] || connected[container.name]) {
        return;
      }
      var label = container.name + ' (' + container.id.substring(0, 12) + ')';
      select.append('<option value="' + escapeHtml(container.id) + '">' + escapeHtml(label) + '</option>');
    });
  }

  function connectSelectedContainer() {
    if (!currentNetwork || !currentNetwork.Id) {
      showActionResult('Error', '<div class="swal-text-block">No selected network</div>', false);
      return;
    }

    var containerId = $('#connectContainerSelect').val();
    if (!containerId) {
      showActionResult('Error', '<div class="swal-text-block">Select a container to connect</div>', false);
      return;
    }

    // Find container in allContainers to get its state
    var selectedContainer = allContainers.find(function (c) {
      return c.id === containerId;
    });

    // Get IP address input if provided
    var ipAddress = $.trim($('#connectContainerIpInput').val() || '');

    // Validate IP if provided
    if (ipAddress !== '') {
      var validation = validateIpAddress(ipAddress);
      if (!validation.valid) {
        showActionResult('Invalid IP Address', '<div class="swal-text-block">' + escapeHtml(validation.error) + '</div>', false);
        logClient('IP validation failed', { ip: ipAddress, error: validation.error }, 'warn', 'ui');
        return;
      }
      logClient('IP address provided', { ip: ipAddress }, 'debug', 'ui');
    }

    var payload = {
      networkId: currentNetwork.Id,
      containerId: containerId
    };
    if (selectedContainer && selectedContainer.name) {
      payload.containerName = selectedContainer.name;
    }
    if (ipAddress !== '') {
      payload.ipAddress = ipAddress;
    }
    if (selectedContainer && selectedContainer.state) {
      payload.containerState = selectedContainer.state;
    }

    apiCall('connect', payload, function (data) {
      if (!data.success) {
        var errorMsg = data.error || 'Failed to connect container';
        showActionResult('Connection Failed', '<div class="swal-text-block">' + escapeHtml(errorMsg) + '</div>', false);
        logClient('Connect container failed', { error: errorMsg, containerId: containerId, state: selectedContainer ? selectedContainer.state : 'unknown' }, 'error', 'network');
        return;
      }

      var message = 'Container connected';
      if (data.ipAddress && data.ipAddress !== 'pending') {
        message += ' (IP: ' + escapeHtml(data.ipAddress) + ')';
      } else if (data.ipAddress === 'pending') {
        message = 'Template updated—container will join network on startup';
      }

      var successMsg = '<div class="swal-text-block">' + escapeHtml(message) + '</div>';
      if (data.warning) {
        successMsg += '<br><span style="color: #ff9800;">' + escapeHtml(data.warning) + '</span>';
      }

      // Clear IP input after successful connection
      $('#connectContainerIpInput').val('');

      showActionResult('Connected', successMsg, true, function () {
        reloadDataAndRefreshManageModal();
      });
    });
  }

  function disconnectContainer(containerId, containerName) {
    function performDisconnect(containerId, containerName) {
      var confirmHtml = '<div class="swal-text-block">';
      confirmHtml += 'Disconnect <strong>' + escapeHtml(containerName) + '</strong>';
      if (currentNetwork && currentNetwork.Name) {
        confirmHtml += ' from <strong>' + escapeHtml(currentNetwork.Name) + '</strong>';
      }
      confirmHtml += '?';
      confirmHtml += '</div>';

      confirmAction(
        'Disconnect Container',
        confirmHtml,
        'Disconnect',
        function () {
          showLoadingModal('Disconnecting Container', 'Removing network connection...');

          var payload = { networkId: currentNetwork.Id, containerId: containerId };
          if (containerName) {
            payload.containerName = containerName;
          }

          apiCall('disconnect', payload, function (data) {
            closeModal();

            if (!data.success) {
              logClient('Container disconnect failed', { error: data.error, container: containerId, network: currentNetwork.Id }, 'error', 'network');

              var errorMsg = '<div class="swal-text-block">';
              errorMsg += '<strong>Failed to disconnect container</strong><br>';
              errorMsg += escapeHtml(data.error || 'Unknown error');
              errorMsg += '</div>';

              showActionResult('Disconnection Failed', errorMsg, false);
              return;
            }

            // Build disconnect message with additional context
            var resultMsg = '<div class="swal-text-block">';

            if (data.containerName && data.networkName) {
              resultMsg += '<strong>' + escapeHtml(data.containerName) + '</strong> disconnected from <strong>' + escapeHtml(data.networkName) + '</strong>';
            } else {
              resultMsg += '<strong>Container disconnected successfully</strong>';
            }

            if (data.ip) {
              resultMsg += '<br>Previous IP: <code>' + escapeHtml(data.ip) + '</code>';
            }

            // Show warning if this was the only network
            if (data.wasOnlyNetwork) {
              resultMsg += '<br><span style="color: #ff5252;"><strong>⚠ This was the container\'s only network attachment. It may now be unreachable.</strong></span>';
              logClient('Container disconnected from only network', { containerName: data.containerName, ip: data.ip }, 'warn', 'network');
            } else if (data.warning) {
              resultMsg += '<br><span style="color: #ff9800;">' + escapeHtml(data.warning) + '</span>';
            }

            resultMsg += '</div>';

            logClient('Container disconnected', { container: containerId, network: currentNetwork.Id, wasOnlyNetwork: data.wasOnlyNetwork }, 'info', 'network');

            showActionResult('Disconnected', resultMsg, true, function () {
              reloadDataAndRefreshManageModal();
            });
          });
        }
      );
    }

    performDisconnect(containerId, containerName);
  }

  function performDeleteNetwork(id, name) {
    apiCall('delete', { id: id }, function (data) {
      if (data.success) {
        logClient('Network deleted', { id: id, name: name }, 'info', 'network');
        showActionResult('Deleted', '<div class="swal-text-block">Network deleted successfully</div>', true, function () {
          if (currentNetwork && currentNetwork.Id === id) {
            closeManageModal();
          }
          loadNetworks({ refreshContainers: false });
        });
      } else {
        logClient('Network delete failed', { id: id, error: data.error }, 'error', 'network');
        showActionResult('Delete Failed', '<div class="swal-text-block">' + escapeHtml(data.error || 'Failed to delete network') + '</div>', false);
      }
    });
  }

  function reloadDataAndRefreshManageModal() {
    setManageLoading(true);
    loadNetworks({ refreshContainers: true }).catch(function (err) {
      showActionResult('Refresh Failed', '<div class="swal-text-block">' + escapeHtml(String(err)) + '</div>', false);
    }).finally(function () {
      setManageLoading(false);
    });
  }

  function createNetwork(event) {
    event.preventDefault();
    var payload = {
      name: $('#networkName').val(),
      driver: $('#networkDriver').val(),
      subnet: $('#networkSubnet').val()
    };

    apiCall('create', payload, function (data) {
      if (data.success) {
        logClient('Network created', { payload: payload, id: data.id }, 'info', 'network');
        showActionResult('Created', '<div class="swal-text-block">Network created successfully</div>', true, function () {
          closeCreateModal();
          loadNetworks({ refreshContainers: false });
        });
      } else {
        logClient('Network create failed', { payload: payload, error: data.error }, 'error', 'network');
        showActionResult('Create Failed', '<div class="swal-text-block">' + escapeHtml(data.error || 'Failed to create network') + '</div>', false);
      }
    });
  }

  function updateNetwork(event) {
    event.preventDefault();
    var payload = {
      id: $('#editNetworkId').val(),
      description: $('#editNetworkDesc').val()
    };

    apiCall('update', payload, function (data) {
      if (data.success) {
        logClient('Network updated', { id: payload.id }, 'info', 'network');
        showActionResult('Updated', '<div class="swal-text-block">Network updated</div>', true, function () {
          closeEditModal();
          loadNetworks({ refreshContainers: false });
        });
      } else {
        logClient('Network update failed', { id: payload.id, error: data.error }, 'error', 'network');
        showActionResult('Update Failed', '<div class="swal-text-block">' + escapeHtml(data.error || 'Failed to update network') + '</div>', false);
      }
    });
  }

  $(function () {
    syncBannerSettings();
    logClient('Banner settings snapshot', {
      userNetworksPersist: userNetworksPersist,
      xmlTemplatePersist: xmlTemplatePersist,
      dockerSettingsUrl: dockerSettingsUrl,
      pluginSettingsUrl: pluginSettingsUrl
    }, 'info', 'settings');
    updateUserNetworksWarning();
    updateTemplatePersistenceWarning();

    $('#btnCreateNetwork').on('click', openCreateModal);
    $('#btnRefreshNetworks').on('click', function () {
      loadNetworks({ showLoading: true, refreshContainers: !!currentNetwork });
    });
    $('#btnPluginSettings').on('click', function () {
      window.location.href = pluginSettingsUrl;
    });
    $('#closeCreateModal').on('click', closeCreateModal);
    $('#btnCancelCreate').on('click', closeCreateModal);
    $('#closeEditModal').on('click', closeEditModal);
    $('#btnCancelEdit').on('click', closeEditModal);
    $('#closeManageModal').on('click', closeManageModal);
    $('#btnCloseManage').on('click', closeManageModal);
    $('#btnConnectContainer').on('click', connectSelectedContainer);

    $('#createNetworkForm').on('submit', createNetwork);
    $('#editNetworkForm').on('submit', updateNetwork);

    loadNetworks({ showLoading: true, refreshContainers: false }).catch(function () {
      return undefined;
    });
    loadContainers();
    logClient('Docker Networks UI initialized', { refreshMs: refreshMs }, 'info', 'ui');
    setInterval(function () {
      loadNetworks({ refreshContainers: !!currentNetwork }).catch(function () {
        return undefined;
      });
    }, refreshMs);
  });
})();