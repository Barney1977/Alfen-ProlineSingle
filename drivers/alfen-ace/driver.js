'use strict';

const Homey = require('homey');

module.exports = class AlfenAceDriver extends Homey.Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this._registerFlowCards();
    this.log('AlfenAceDriver initialized');
  }

  /**
   * Flow-kaarten één keer per driver registreren en via args.device naar het
   * juiste device routeren. (Voorheen per device in onInit, waardoor bij meerdere
   * laders de laatst geïnitialiseerde alle kaarten "overnam".)
   */
  _registerFlowCards() {
    const action    = id => this.homey.flow.getActionCard(id);
    const condition = id => this.homey.flow.getConditionCard(id);

    action('update_grid_current').registerRunListener(async args => {
      await args.device.flowUpdateGridCurrent(
        Number(args.current_l1),
        Number(args.current_l2),
        Number(args.current_l3),
      );
      return true;
    });
    action('set_max_current').registerRunListener(async args => {
      await args.device.flowSetMaxCurrent(args.current);
      return true;
    });
    action('pause_charging').registerRunListener(async args => {
      await args.device.flowPauseCharging();
      return true;
    });
    action('resume_charging').registerRunListener(async args => {
      await args.device.flowResumeCharging();
      return true;
    });
    action('set_charge_phases').registerRunListener(async args => {
      await args.device.flowSetChargePhases(Number(args.phases));
      return true;
    });
    action('set_solar_mode').registerRunListener(async args => {
      await args.device.flowSetSolarMode(args.state === 'on');
      return true;
    });

    condition('is_charging').registerRunListener(async args => args.device.flowIsCharging());
    condition('is_car_connected').registerRunListener(async args => args.device.flowIsCarConnected());
    condition('is_paused').registerRunListener(async args => args.device.flowIsPaused());
    condition('is_solar_mode').registerRunListener(async args => args.device.flowIsSolarMode());
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
