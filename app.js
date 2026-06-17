'use strict';

const Homey   = require('homey');
const { HomeyAPI } = require('homey-api');

class AlfenAceApp extends Homey.App {

  async onInit() {
    this.log('Alfen ACE app initialising');

    // Create a single HomeyAPI instance shared across all device instances.
    // Used exclusively to subscribe to measure_current.L1/L2/L3 on a
    // user-configured local energy meter device for load balancing purposes.
    // No data is written to external devices or transmitted outside the local network.
    // Requires 'homey:manager:api' permission in app.json.
    try {
      this.homeyApi = await HomeyAPI.createAppAPI({ homey: this.homey });
      this.log('HomeyAPI ready');
    } catch (err) {
      this.error('HomeyAPI init failed:', err.message);
      this.homeyApi = null;
    }

    this.log('Alfen ACE app ready');
  }

  async onUninit() {
    // Disconnect the HomeyAPI WebSocket on app unload to free resources
    if (this.homeyApi) {
      try {
        await this.homeyApi.destroy();
      } catch (_) {}
      this.homeyApi = null;
    }
    this.log('Alfen ACE app uninit');
  }

}

module.exports = AlfenAceApp;
