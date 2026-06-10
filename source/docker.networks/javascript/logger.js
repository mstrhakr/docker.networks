(function () {
  'use strict';

  function postLog(payload) {
    var endpoint = window.dockerNetworksApiUrl || '/plugins/docker.networks/include/Exec.php';
    try {
      $.post(endpoint, payload).fail(function () { });
    } catch (e) {
      // Best effort only.
    }
  }

  window.dockerNetworksLogger = function (msg, data, type, level, category) {
    var payload = {
      action: 'dockerLogger',
      msg: String(msg || ''),
      type: type || 'user',
      lvl: level || 'info'
    };

    if (category) {
      payload.category = String(category);
    }
    if (data !== undefined) {
      try {
        payload.data = JSON.stringify(data);
      } catch (e) {
        payload.data = String(data);
      }
    }

    postLog(payload);

    try {
      var prefix = '[INFO]';
      if ((level || '').toLowerCase() === 'debug') prefix = '[DEBUG]';
      if ((level || '').toLowerCase() === 'warn' || (level || '').toLowerCase() === 'warning') prefix = '[WARN]';
      if ((level || '').toLowerCase() === 'err' || (level || '').toLowerCase() === 'error') prefix = '[ERROR]';
      var line = 'docker.networks: ' + prefix + ' ' + msg;
      if (category) {
        line = 'docker.networks: [' + category + '] ' + prefix + ' ' + msg;
      }
      if (data !== undefined) {
        console.log(line, data);
      } else {
        console.log(line);
      }
    } catch (e) {
      // Ignore console failures.
    }
  };
})();
