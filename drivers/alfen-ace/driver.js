'use strict';

const Homey = require('homey');

module.exports = class AlfenAceDriver extends Homey.Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('AlfenAceDriver initialized');
  }

  /**
   * onPairListDevices is called when a user is adding a device
   * and the 'list_devices' view is reached.
   * Settings entered via the pair UI are available via this.pairSettings
   * (set by the 'generic_credentials' template through onPair / settingsChanged).
   *
   * In SDK3, custom pair views use session.setHandler in onPair().
   * Here we use the simpler approach: settings are passed in the device object.
   */
  async onPair(session) {
    this.log('onPair()');

    // Store settings entered in the pair UI
    let pairSettings = {
      ip:   '',
      port: 502,
    };

    session.setHandler('settingsChanged', async (data) => {
      this.log('Pair settingsChanged:', data);
      pairSettings = data;
      return true;
    });

    session.setHandler('getSettings', async () => {
      return pairSettings;
    });

    session.setHandler('list_devices', async () => {
      if (!pairSettings.ip) {
        throw new Error(this.homey.__('errors.ip_required'));
      }
      if (!Number(pairSettings.port)) {
        throw new Error(this.homey.__('errors.port_required'));
      }

      return [
        {
          name: this.homey.__('pair.device_name'),
          data: {
            id: this._generateId(),
          },
          settings: {
            ip:   pairSettings.ip,
            port: Number(pairSettings.port),
          },
        },
      ];
    });
  }

  _generateId() {
    const s4 = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1);
    return `${s4()}${s4()}-${s4()}-${s4()}-${s4()}-${s4()}${s4()}${s4()}`;
  }

};
