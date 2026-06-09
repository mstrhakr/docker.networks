(function () {
  'use strict';

  var apiBase = window.dockerNetworksApiUrl || '/plugins/docker.networks/include/Exec.php';
  var refreshMs = (window.dockerNetworksRefreshInterval || 30) * 1000;
  var userNetworksPersist = !!window.dockerNetworksUserNetworksPersist;
  var dockerSettingsUrl = window.dockerNetworksSettingsUrl || '/Settings/Docker';
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

  function updateUserNetworksWarning() {
    var warning = $('#dockerUserNetworksWarning');
    if (userNetworksPersist) {
      warning.hide();
      return;
    }

    warning.html('Docker setting <strong>"Preserve user defined networks"</strong> is currently disabled. Connections may be lost when Docker/server restarts. <a href="' + escapeHtml(dockerSettingsUrl) + '">Open Docker Settings</a> to enable it.');
    warning.show();
  }

  function logClient(msg, data, level, category) {
    if (typeof window.dockerNetworksLogger === 'function') {
      window.dockerNetworksLogger(msg, data, 'user', level || 'info', category || 'ui');
    }
  }

  function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  function apiCall(action, payload, onSuccess) {
    var requestBody = payload || {};
    requestBody.action = action;

    $.ajax({
      url: apiBase,
      method: 'POST',
      dataType: 'json',
      data: requestBody,
      success: onSuccess,
      error: function (xhr, status, error) {
        logClient('API call failed', { action: action, status: status, error: error, response: xhr && xhr.responseText ? xhr.responseText : '' }, 'error', 'api');
        showMessage('Error: ' + error, true);
      }
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
    actions.append(createActionButton('Edit', 'button orange-button', function () { openEditModal(net); }));
    actions.append(createActionButton('Manage', 'button orange-button', function () { openManageModal(net); }));
    actions.append(createActionButton('Delete', 'button docker-networks-danger-button', function () { deleteNetwork(net.Id, net.Name, !!net.IsProtected, net.ProtectionLabel); }, !!net.IsProtected));

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
      showMessage('Unable to load containers: ' + err, true);
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
      logClient('Networks loaded', { count: (data.networks || []).length }, 'debug', 'api');
      return data;
    }).catch(function (err) {
      logClient('Load networks failed', { error: String(err) }, 'error', 'api');
      showMessage(String(err), true);
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
      showMessage('No selected network', true);
      return;
    }

    var containerId = $('#connectContainerSelect').val();
    if (!containerId) {
      showMessage('Select a container to connect', true);
      return;
    }

    apiCall('connect', { networkId: currentNetwork.Id, containerId: containerId }, function (data) {
      if (!data.success) {
        showMessage(data.error || 'Failed to connect container', true);
        return;
      }

      if (data.warning) {
        showMessage(data.warning, true);
      } else {
        showMessage('Container connected', false);
      }
      reloadDataAndRefreshManageModal();
    });
  }

  function disconnectContainer(containerId, containerName) {
    if (!currentNetwork || !currentNetwork.Id) {
      showMessage('No selected network', true);
      return;
    }
    confirmAction(
      'Disconnect Container',
      '<div class="swal-text-block">Disconnect <strong>' + escapeHtml(containerName) + '</strong> from this network?</div>',
      'Disconnect',
      function () {
        apiCall('disconnect', { networkId: currentNetwork.Id, containerId: containerId }, function (data) {
          if (!data.success) {
            showMessage(data.error || 'Failed to disconnect container', true);
            return;
          }

          if (data.warning) {
            showMessage(data.warning, true);
          } else {
            showMessage('Container disconnected', false);
          }
          reloadDataAndRefreshManageModal();
        });
      }
    );
  }

  function performDeleteNetwork(id, name) {
    apiCall('delete', { id: id }, function (data) {
      if (data.success) {
        logClient('Network deleted', { id: id, name: name }, 'info', 'network');
        showMessage('Network deleted successfully', false);
        if (currentNetwork && currentNetwork.Id === id) {
          closeManageModal();
        }
        loadNetworks({ refreshContainers: false });
      } else {
        logClient('Network delete failed', { id: id, error: data.error }, 'error', 'network');
        showMessage(data.error || 'Failed to delete network', true);
      }
    });
  }

  function reloadDataAndRefreshManageModal() {
    setManageLoading(true);
    loadNetworks({ refreshContainers: true }).catch(function (err) {
      showMessage(String(err), true);
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
        showMessage('Network created successfully', false);
        closeCreateModal();
        loadNetworks({ refreshContainers: false });
      } else {
        logClient('Network create failed', { payload: payload, error: data.error }, 'error', 'network');
        showMessage(data.error || 'Failed to create network', true);
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
        logClient('Network updated', { payload: payload }, 'info', 'network');
        showMessage('Network updated successfully', false);
        closeEditModal();
        loadNetworks({ refreshContainers: false });
      } else {
        logClient('Network update failed', { payload: payload, error: data.error }, 'error', 'network');
        showMessage(data.error || 'Failed to update network', true);
      }
    });
  }

  function deleteNetwork(id, name, isProtected, protectionLabel) {
    if (isProtected) {
      showMessage((protectionLabel || 'Protected') + ' Docker networks cannot be deleted', true);
      return;
    }

    confirmAction(
      'Delete Network',
      '<div class="swal-text-block">Delete network <strong>"' + escapeHtml(name) + '"</strong>?<br><br>This cannot be undone.</div>',
      'Delete',
      function () {
        performDeleteNetwork(id, name);
      }
    );
  }

  $(function () {
    updateUserNetworksWarning();

    $('#btnCreateNetwork').on('click', openCreateModal);
    $('#btnRefreshNetworks').on('click', function () {
      loadNetworks({ showLoading: true, refreshContainers: !!currentNetwork });
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

    loadContainers().then(function () {
      return loadNetworks({ showLoading: true, refreshContainers: false });
    });
    logClient('Docker Networks UI initialized', { refreshMs: refreshMs }, 'info', 'ui');
    setInterval(function () {
      loadNetworks({ refreshContainers: !!currentNetwork }).catch(function () {
        return undefined;
      });
    }, refreshMs);
  });
})();
