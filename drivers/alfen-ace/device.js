'use strict';

const Homey  = require('homey');
const net    = require('net');
const Modbus = require('jsmodbus');

// ─── Timing ───────────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS      = 30 * 1000;
const RECONNECT_DELAY_MS    =  5 * 1000;
const CONNECT_TIMEOUT_MS    =  8 * 1000;
const LB_INTERVAL_DEFAULT_S = 30;
const LB_INTERVAL_MIN_S     = 10;
const ALFEN_VALIDITY_TIME_S = 60;
const PAUSE_CURRENT_A       =  5; // below IEC 61851 minimum (6A) → car stops drawing, session stays active

// ─── Alfen Modbus server addresses ───────────────────────────────────────────
const UNIT_SOCKET1 =   1; // Alfen socket registers (all measurements + control)

// ─── Register addresses = datasheet addresses (no -1 offset on this firmware) ─
const REG_MODE3_BULK          = 1200; // bulk read start (Mode3 state)
const REG_ACTUAL_MAX_A        = 1206;
const REG_VALID_TIME_LEFT     = 1208;
const REG_MAX_CURRENT_RW      = 1210; // R/W
const REG_SAFE_CURRENT        = 1212;
const REG_PHASES              = 1215;
const REG_SETPOINT_ACCOUNTED  = 1214;
const REG_VOLTAGE_L1          =  306;
const REG_CURRENT_L1          =  320;
const REG_POWER_L1            =  338;
const REG_ENERGY_SUM          =  374;

const LOG = false;

// ─── Mode3 helpers ────────────────────────────────────────────────────────────
function mode3ToChargingState(m) {
  const s = (m || '').trim().toUpperCase();
  if (s === 'A' || s === 'E' || s === 'F') return 'plugged_out';
  if (s === 'B1' || s === 'B2')            return 'plugged_in';
  if (s === 'C2' || s === 'D2')            return 'plugged_in_charging';
  if (s === 'C1' || s === 'D1')            return 'plugged_in_paused';
  return 'plugged_out';
}
const isActivelyCharging = m => ['C2','D2'].includes((m||'').trim().toUpperCase());
const isCarConnected     = m => ['B1','B2','C1','C2','D1','D2'].includes((m||'').trim().toUpperCase());

// ─── Float helpers ────────────────────────────────────────────────────────────
function parseFloat32(buf, offset = 0) {
  // Standard big-endian: high word first (no swap needed on this firmware)
  return buf.readFloatBE(offset);
}
function encodeFloat32(value) {
  const b = Buffer.alloc(4);
  b.writeFloatBE(value, 0);
  return [b.readUInt16BE(0), b.readUInt16BE(2)]; // high word first
}
function parseFloat64(buf, offset = 0) {
  // Standard big-endian
  return buf.readDoubleBE(offset);
}
function parseString(buf, offset, numRegs) {
  let s = '';
  for (let i = 0; i < numRegs * 2; i++) {
    const c = buf[offset + i]; if (c === 0) break; s += String.fromCharCode(c);
  }
  return s.trim();
}

// ─── Device ───────────────────────────────────────────────────────────────────
module.exports = class AlfenAceDevice extends Homey.Device {

  async onInit() {
    this.log(`Device init: ${this.getName()} (${this.getData().id})`);

    this._settings        = this.getSettings();

    // Initialize meter_active sensor to false (updated when meter data arrives)
    await this._setCapSafe('meter_active', false);

    // Initialize any missing settings to their defaults
    // (happens when device was paired before these settings existed)
    const settingDefaults = {
      grid_phases:          '3',
      grid_fuse_A:           25,
      max_current_limit:     16,
      meter_device_id:       '',
      lb_enabled:          true,
      lb_interval:           30,
      lb_safety_margin_A:     1,
    };
    const missingSettings = {};
    for (const [key, defaultVal] of Object.entries(settingDefaults)) {
      if (this._settings[key] === undefined || this._settings[key] === null) {
        missingSettings[key] = defaultVal;
      }
    }
    if (Object.keys(missingSettings).length > 0) {
      this.log('Initializing missing settings:', Object.keys(missingSettings));
      await this.setSettings(missingSettings);
      this._settings = this.getSettings();
    }
    this._socketConnected = false;
    this._pollingTimer    = null;
    this._lbTimer         = null;
    this._reconnecting    = false;
    this._lastMode3       = null;
    this._lbSetpointA        = null;   // last value written to charger (A)
    this._userMaxA            = null;   // user's desired maximum (slider/flow), LB upper bound
    this._paused              = false;  // true when charge is intentionally paused
    this._prePauseSetpointA   = null;   // setpoint to restore on resume
    this._gridCurrentA    = { L1: null, L2: null, L3: null };
    this._gridLastUpdateMs  = null;  // timestamp of last grid measurement
    this._meterConfigured   = false; // true once meter_device_id is set and listener attached
    this._meterHasData      = false; // true once first value received from meter
    this._meterActive       = false; // true when meter data is fresh and LB is active
    this._validTimeCountdown = null;  // timer for 5s valid_time_remaining countdown
    this._chargerCurrentA   = { L1: 0, L2: 0, L3: 0 }; // actual charger current from Alfen poll

    // Capability instances for the external energy meter (HomeyAPI-based)
    this._meterCapInstances = [];

    this._applyCurrentLimits();
    this._validateLbInterval();

    // ── Modbus — single TCP socket, unit 1 ─────────────────────────────────
    // Unit 1 covers all registers: measurements (306-425), status (1200-1215),
    // max current R/W (1210). Unit 200 (station registers) is not used —
    // those registers are only available on SCN-connected chargers.
    this._socket        = new net.Socket();
    this._clientSocket1 = new Modbus.client.TCP(this._socket, UNIT_SOCKET1);

    this._socket.setKeepAlive(true);
    this._socket.setMaxListeners(20);

    this._socket.on('connect', () => {
      this._socketConnected   = true;
      this._reconnecting      = false;
      this._reconnectAttempts = 0;
      this.log('Socket connected');
      this.setAvailable().catch(this.error.bind(this));
    });
    this._socket.on('end',     () => this.log('Socket ended'));
    this._socket.on('timeout', () => { this.log('Socket timeout'); this._socket.destroy(); });
    this._socket.on('error',   err => this.log('Socket error:', err.message));
    this._socket.on('close', () => {
      this._socketConnected = false;
      this.log('Socket closed');
      this.setUnavailable(this.homey.__('device.disconnected')).catch(this.error.bind(this));
      this._scheduleReconnect();
    });

    // ── Capability listeners ─────────────────────────────────────────────────
    this.registerCapabilityListener('max_current', async value => {
      await this._writeMaxCurrentDirect(value);
    });
    this.registerCapabilityListener('evcharger_charging', async value => {
      if (value) {
        await this._resumeCharging();
      } else {
        await this._pauseCharging();
      }
    });

    this.registerCapabilityListener('charge_phases', async value => {
      await this._writePhases(Number(value));
    });

    // ── Flow actions ─────────────────────────────────────────────────────────

    // Fallback: manual grid current update via flow (when no meter_device_id set)
    this.homey.flow
      .getActionCard('update_grid_current')
      .registerRunListener(async args => {
        await this._updateGridCurrent(
          Number(args.current_l1),
          Number(args.current_l2),
          Number(args.current_l3),
        );
        return true;
      });

    this.homey.flow
      .getActionCard('set_max_current')
      .registerRunListener(async args => {
        await this._writeMaxCurrentDirect(args.current);
        return true;
      });

    this.homey.flow
      .getActionCard('pause_charging')
      .registerRunListener(async () => {
        await this._pauseCharging();
        return true;
      });

    this.homey.flow
      .getActionCard('resume_charging')
      .registerRunListener(async () => {
        await this._resumeCharging();
        return true;
      });

    this.homey.flow
      .getActionCard('set_charge_phases')
      .registerRunListener(async args => {
        await this._writePhases(Number(args.phases));
        return true;
      });

    // ── Flow conditions ──────────────────────────────────────────────────────
    this.homey.flow
      .getConditionCard('is_charging')
      .registerRunListener(() => isActivelyCharging(this._lastMode3));
    this.homey.flow
      .getConditionCard('is_car_connected')
      .registerRunListener(() => isCarConnected(this._lastMode3));

    this.homey.flow
      .getConditionCard('is_paused')
      .registerRunListener(() => this._paused);

    // ── Connect + start timers ───────────────────────────────────────────────
    await this.delay(1500);
    try {
      await this._connect();
    } catch (err) {
      this.log('Initial connect failed:', err.message);
      this.setUnavailable(this.homey.__('device.disconnected')).catch(this.error.bind(this));
    }

    this._startPolling();
    this._startLoadBalancing();

    // Attach meter listener after a short delay to ensure HomeyAPI is ready
    this.homey.setTimeout(() => this._attachMeterListeners().catch(e => this.log('Meter attach err:', e.message)), 3000);
  }

  // ── Energy meter listeners (HomeyAPI) ─────────────────────────────────────
  //
  // Uses HomeyAPI.makeCapabilityInstance() to subscribe to real-time
  // capability value changes on an external energy meter device.
  // The meter device ID is stored in device settings (meter_device_id).
  //
  // When a new current measurement arrives, _updateGridCurrent() is called
  // immediately — no flow required.
  //
  // For 3-phase: subscribes to measure_current.L1, .L2, .L3
  // For 1-phase: subscribes to measure_current.L1 only

  async _attachMeterListeners() {
    // Clean up any previous listeners first
    this._destroyMeterListeners();

    const deviceId = (this._settings.meter_device_id || '').trim();
    if (!deviceId) {
      this.log('No meter_device_id configured — using flow action for grid current');
      return;
    }

    // HomeyAPI is initialised in app.js and shared via this.homey.app
    const homeyApi = this.homey.app.homeyApi;
    if (!homeyApi) {
      this.log('HomeyAPI not available — cannot attach meter listeners');
      this.setWarning('HomeyAPI not available — check app permissions').catch(() => {});
      return;
    }

    let meterDevice;
    try {
        meterDevice = await homeyApi.devices.getDevice({ id: deviceId });
    } catch (err) {
      this.log(`Meter device '${deviceId}' not found: ${err.message}`);
      this.setWarning(this.homey.__('warnings.meter_device_not_found')).catch(() => {});
      return;
    }

    const numPhases = Number(this._settings.grid_phases) || 3;
    const caps = numPhases === 1
      ? ['measure_current.l1']
      : ['measure_current.l1', 'measure_current.l2', 'measure_current.l3'];

    // Verify the meter device actually has these capabilities
    const available = caps.filter(cap => meterDevice.capabilitiesObj?.[cap] !== undefined);
    if (available.length === 0) {
      this.log(`Meter device has none of: ${caps.join(', ')} — available current caps:`,
        Object.keys(meterDevice.capabilitiesObj || {}).filter(c => c.includes('current') || c.includes('power')));
      this.setWarning(this.homey.__('warnings.meter_capability_missing')).catch(() => {});
      // Safety: limit to 6A minimum since we cannot monitor grid load
      this._meterConfigured = true;  // mark as configured so stale logic activates
      this._meterHasData    = false; // but no data → LB will use 6A safe minimum
      return;
    }

    // Show 'waiting' warning — cleared when first live value arrives in callback
    this.setWarning(this.homey.__('warnings.meter_waiting_for_data')).catch(() => {});
    this._meterHasData = false;
    this._meterActive   = false;
    this._setCapSafe('meter_active', false).catch(() => {});
    this.log(`Attaching meter listeners on '${meterDevice.name}' for: ${available.join(', ')}`);

    for (const cap of available) {
      const instance = meterDevice.makeCapabilityInstance(cap, value => {
        // Update the relevant phase and recalculate
        if (cap === 'measure_current.l1') this._gridCurrentA.L1 = value;
        if (cap === 'measure_current.l2') this._gridCurrentA.L2 = value;
        if (cap === 'measure_current.l3') this._gridCurrentA.L3 = value;
        this._gridLastUpdateMs = Date.now();
        // Clear 'waiting' warning on first received value
        if (!this._meterHasData) {
          this._meterHasData  = true;
          this._meterActive   = true;
          this.unsetWarning().catch(() => {});
          this._setCapSafe('meter_active', true).catch(() => {});
          this.log('Meter data received — warning cleared');
        }
        this._recalculateAndWrite().catch(e => this.log('LB recalc err:', e.message));
      });
      this._meterCapInstances.push(instance);
    }

    this._meterConfigured = true;
    this.log(`Meter listeners active (${this._meterCapInstances.length} capabilities)`);
  }

  _destroyMeterListeners() {
    for (const inst of this._meterCapInstances) {
      try { inst.destroy(); } catch (_) {}
    }
    this._meterCapInstances = [];
    this._meterHasData      = false;
    this._meterActive       = false;
    this._setCapSafe('meter_active', false).catch(() => {});
  }

  // ── Load balancing calculation ────────────────────────────────────────────
  //
  // Called either by:
  //   (a) _attachMeterListeners callback  — real-time, triggered by meter changes
  //   (b) _updateGridCurrent flow action  — manual fallback
  //   (c) _lbKeepalive timer              — Alfen validity time refresh
  //
  // Formula per phase:
  //   available_Ln = fuse_A − grid_Ln_A + charger_A − safety_margin_A
  //
  // The current charger setpoint is added back because the meter measures
  // total load including the charger. Without this correction every tick
  // would reduce the setpoint until it hits the minimum.
  //
  // Setpoint = clamp(min(available phases), 6, cable_max_A)

  _calculateLbSetpoint() {
    // While paused, always return the pause current regardless of LB logic
    if (this._paused) return PAUSE_CURRENT_A;
    const fuseA    = Number(this._settings.grid_fuse_A)        || 25;
    const cableMax = Number(this._settings.max_current_limit)  || 16;
    const margin   = Number(this._settings.lb_safety_margin_A) ||  1;
    const phases   = Number(this._settings.grid_phases)        ||  3;
    // Use actual measured charger current per phase from the Alfen for accuracy.
    // Falls back to setpoint if charger hasn't been polled yet (startup).
    const fallbackA  = this._lbSetpointA || 0;
    const chargerA   = {
      L1: this._chargerCurrentA.L1 > 0 ? this._chargerCurrentA.L1 : fallbackA,
      L2: this._chargerCurrentA.L2 > 0 ? this._chargerCurrentA.L2 : fallbackA,
      L3: this._chargerCurrentA.L3 > 0 ? this._chargerCurrentA.L3 : fallbackA,
    };

    // Determine if grid data is fresh enough to trust.
    // Stale threshold = 2× lb_interval (gives one missed cycle before acting).
    const staleMs    = (Number(this._settings.lb_interval) || 30) * 2 * 1000;
    const dataStale  = this._gridLastUpdateMs !== null
      && (Date.now() - this._gridLastUpdateMs) > staleMs;
    const noDataYet  = this._gridLastUpdateMs === null && this._meterConfigured;

    // If meter is configured but data is stale or not yet received:
    // → fall back to the safe minimum (6 A) to prevent overload.
    if (dataStale || noDataYet) {
      if (dataStale) this.log('Grid data stale — falling back to 6 A safe minimum');
      if (noDataYet) this.log('Awaiting first grid measurement — holding at 6 A');
      return 6; // safe minimum per Alfen spec
    }

    // Upper bound for LB output:
    // If user has set a manual maximum via slider, respect it — LB can only
    // reduce below it, never increase above it.
    const userMax = this._userMaxA !== null
      ? Math.min(this._userMaxA, cableMax)
      : cableMax;

    // When no meter is configured: repeat last written value to keep
    // the Alfen validity timer alive without overriding manual adjustments.
    if (!this._meterConfigured) {
      return this._lbSetpointA !== null
        ? Math.max(6, Math.min(this._lbSetpointA, userMax))
        : userMax;
    }

    const avail = phase => {
      const measured = this._gridCurrentA[phase];
      if (measured === null) return cableMax;
      const phaseCharger = typeof chargerA === 'object' ? (chargerA[phase] || 0) : chargerA;
      return fuseA - measured + phaseCharger - margin;
    };

    const setpoint = phases === 1
      ? avail('L1')
      : Math.min(avail('L1'), avail('L2'), avail('L3'));

    const clamped = Math.max(6, Math.min(Math.round(setpoint), userMax));

    if (LOG) this.log(`LB calc: fuse=${fuseA} cable=${cableMax} margin=${margin} charger=${chargerA} → ${setpoint.toFixed(1)} → clamped=${clamped}`);
    return clamped;
  }

  async _recalculateAndWrite() {
    if (!this._socketConnected) return;
    const setpoint = this._calculateLbSetpoint();
    if (setpoint === this._lbSetpointA) return; // no change, skip write
    this.log(`LB setpoint: ${this._lbSetpointA} → ${setpoint} A`);
    this._lbSetpointA = setpoint;
    await this._writeMaxCurrentRaw(setpoint);
    await this._setCapSafe('max_current', setpoint);
  }

  // Called by flow action (manual fallback when no meter_device_id)
  async _updateGridCurrent(l1, l2, l3) {
    this._gridCurrentA    = { L1: l1, L2: l2, L3: l3 };
    this._gridLastUpdateMs = Date.now();
    this._meterConfigured  = true; // flow-action path also counts as configured
    await this._recalculateAndWrite();
  }

  // ── LB keepalive timer ────────────────────────────────────────────────────
  //
  // Even when the meter pushes updates frequently, the Alfen validity timer
  // requires a write within 60 s. The keepalive ensures this regardless of
  // whether the meter is sending data.

  _lbIntervalMs() {
    const s = Math.max(LB_INTERVAL_MIN_S, Math.min(Number(this._settings.lb_interval) || LB_INTERVAL_DEFAULT_S, ALFEN_VALIDITY_TIME_S - 1));
    return s * 1000;
  }

  _validateLbInterval() {
    const s = Number(this._settings.lb_interval) || LB_INTERVAL_DEFAULT_S;
    if (s >= ALFEN_VALIDITY_TIME_S) {
      this.setWarning(this.homey.__('warnings.lb_interval_too_high')).catch(() => {});
    } else {
      this.unsetWarning().catch(() => {});
    }
  }

  _startLoadBalancing() {
    if (!this._settings.lb_enabled) { this.log('LB keepalive disabled'); return; }
    const ms = this._lbIntervalMs();
    this.log(`LB keepalive started — ${ms / 1000} s interval`);
    this._lbTimer = this.homey.setInterval(() => this._lbKeepalive(), ms);
  }

  _stopLoadBalancing()    { if (this._lbTimer) { this.homey.clearInterval(this._lbTimer); this._lbTimer = null; } }
  _restartLoadBalancing() { this._stopLoadBalancing(); this._startLoadBalancing(); }

  async _lbKeepalive() {
    if (!this._socketConnected) return;
    // Recalculate — _calculateLbSetpoint() handles stale/missing data by
    // returning 6 A safe minimum when meter data is absent or too old.
    const staleMs   = (Number(this._settings.lb_interval) || 30) * 2 * 1000;
    const dataStale = this._gridLastUpdateMs !== null
      && (Date.now() - this._gridLastUpdateMs) > staleMs;
    // Calculate current meter state
    const meterNowActive = this._meterConfigured
      && this._meterHasData
      && !dataStale;

    // Always write meter_active every keepalive so value is never
    // older than the keepalive interval (default 30s, max 59s)
    this._meterActive = meterNowActive;
    await this._setCapSafe('meter_active', meterNowActive);

    if (dataStale) {
      this.setWarning(this.homey.__('warnings.meter_data_stale')).catch(() => {});
    } else if (this._meterConfigured && this._meterHasData) {
      this.unsetWarning().catch(() => {});
    }
    const setpoint = this._calculateLbSetpoint();
    this._lbSetpointA = setpoint;
    try {
      await this._writeMaxCurrentRaw(setpoint);
      await this._setCapSafe('max_current', setpoint);
      if (LOG) this.log(`LB keepalive wrote ${setpoint} A`);
    } catch (err) {
      this.log(`LB keepalive write failed: ${err.message}`);
    }
  }

  // ── Connection ────────────────────────────────────────────────────────────

  async _connect() {
    if (this._socketConnected) return;
    return new Promise((resolve, reject) => {
      const { ip: host, port = 502 } = this._settings;
      this.log(`Connecting to ${host}:${port}`);
      const timer     = this.homey.setTimeout(() => { this._socket.destroy(); reject(new Error('Connection timeout')); }, CONNECT_TIMEOUT_MS);
      const onError   = err => { this.homey.clearTimeout(timer); this._socket.removeListener('connect', onConnect); reject(err); };
      const onConnect = ()  => { this.homey.clearTimeout(timer); this._socket.removeListener('error', onError); resolve(); };
      this._socket.once('connect', onConnect);
      this._socket.once('error', onError);
      this._socket.connect(port, host);
    });
  }

  async _disconnect() {
    return new Promise(resolve => {
      if (!this._socketConnected) { resolve(); return; }
      this._socket.once('close', resolve);
      this._socket.end();
    });
  }

  _scheduleReconnect() {
    if (this._reconnecting) return;
    this._reconnecting = true;
    this._reconnectAttempts++;
    const delay = Math.min(RECONNECT_DELAY_MS * Math.pow(2, this._reconnectAttempts - 1), 30000);
    this.log(`Reconnect attempt ${this._reconnectAttempts} in ${delay / 1000}s`);
    this.homey.setTimeout(async () => {
      try { await this._connect(); } catch (err) {
        this.log('Reconnect failed:', err.message);
        this._reconnecting = false;
        this._scheduleReconnect();
      }
    }, delay);
  }

  async onSettings({ newSettings, changedKeys }) {
    this._settings = newSettings;

    if (changedKeys.includes('max_current_limit')) {
      this._applyCurrentLimits();
      if (this._lbSetpointA !== null) {
        const hwMax = Number(this._settings.max_current_limit) || 16;
        this._lbSetpointA = Math.min(this._lbSetpointA, hwMax);
      }
    }

    if (changedKeys.includes('meter_device_id') || changedKeys.includes('grid_phases')) {
      await this._attachMeterListeners().catch(e => this.log('Re-attach meter err:', e.message));
    }

    if (changedKeys.some(k => ['lb_interval','lb_enabled','grid_fuse_A','lb_safety_margin_A'].includes(k))) {
      this._validateLbInterval();
      this._restartLoadBalancing();
    }

    if (changedKeys.includes('ip') || changedKeys.includes('port')) {
      try { await this._disconnect(); } catch (_) {}
      await this._connect();
    }
  }

  // ── Polling ───────────────────────────────────────────────────────────────

  _startPolling() {
    this._pollAll().catch(err => this.log('Initial poll error:', err.message));
    this._pollingTimer = this.homey.setInterval(async () => {
      if (!this._socketConnected) return;
      try { await this._pollAll(); } catch (err) { this.log('Poll error:', err.message); }
    }, POLL_INTERVAL_MS);
  }

  async _pollAll() {
    await this._pollSocketStatus();
    await this._pollMeasurements();
  }

  async _pollSocketStatus() {
    // ── Single bulk read: registers 1200–1214 (15 registers, 1 TCP request) ──
    // Register layout (datasheet address = Modbus address on this firmware):
    //   offset  0 (1200): Mode3 state [0..4] STRING (5 regs = 10 bytes)
    //   offset 10 (1205→1206): Actual max current FLOAT32 (2 regs)
    //   offset 14 (1207→1208): Valid time         UNSIGNED32 big-endian (2 regs)
    //   offset 18 (1209→1210): Max current R/W    FLOAT32 (2 regs)
    //   offset 22 (1211→1212): Safe current       FLOAT32 (2 regs)
    //   offset 26 (1213→1214): Setpoint accounted UNSIGNED16
    //   offset 28 (1214→1215): Charge phases      UNSIGNED16
    try {
      const res = await this._clientSocket1.readHoldingRegisters(REG_MODE3_BULK, 16);
      const b   = res.response._body.valuesAsBuffer;

      this.unsetWarning().catch(() => {}); // clear any previous error warning
      // Refresh meter_active every poll cycle
      // Active = meter configured + data received + data not stale
      const staleMs2 = (Number(this._settings.lb_interval) || 30) * 2 * 1000;
      const dataIsStale = this._gridLastUpdateMs !== null
        && (Date.now() - this._gridLastUpdateMs) > staleMs2;
      const isActive = this._meterConfigured
        && this._meterHasData
        && !dataIsStale;
      if (isActive !== this._meterActive) {
        this._meterActive = isActive;
      }
      await this._setCapSafe('meter_active', isActive);
      // Reg 1200 = Availability (offset 0, 1 reg = 2 bytes) — skip
      // Mode3 state (offset 2, 5 regs = 10 bytes) → regs 1201-1205
      const mode3 = parseString(b, 2, 5) || 'A';
      const prev  = this._lastMode3;
      if (prev !== null) {
        if (!isActivelyCharging(prev) && isActivelyCharging(mode3))
          this.homey.flow.getDeviceTriggerCard('charging_started').trigger(this).catch(this.error.bind(this));
        if (isActivelyCharging(prev) && !isActivelyCharging(mode3))
          this.homey.flow.getDeviceTriggerCard('charging_stopped').trigger(this).catch(this.error.bind(this));
        if (!isCarConnected(prev) && isCarConnected(mode3))
          this.homey.flow.getDeviceTriggerCard('car_connected').trigger(this).catch(this.error.bind(this));
        if (isCarConnected(prev) && !isCarConnected(mode3))
          this.homey.flow.getDeviceTriggerCard('car_disconnected').trigger(this).catch(this.error.bind(this));
      }
      this._lastMode3 = mode3;
      await this._setCapSafe('evcharger_charging_state', mode3ToChargingState(mode3));
      if (!this._paused) {
        await this._setCapSafe('evcharger_charging', isActivelyCharging(mode3));
      }

      // Actual applied max current (offset 12, 2 regs FLOAT32) → regs 1206-1207
      await this._setCapSafe('actual_max_current', this._clean(parseFloat32(b, 12)));

      // Remaining valid time (offset 16, 2 regs UNSIGNED32 big-endian) → regs 1208-1209
      const validTimeSec = (b.readUInt16BE(16) << 16) | b.readUInt16BE(18);
      await this._setCapSafe('valid_time_remaining', validTimeSec);
      this._startValidTimeCountdown(validTimeSec); // update UI every 5s

      // Max current R/W setpoint (offset 20, 2 regs FLOAT32) → regs 1210-1211
      const maxCurrVal = this._clean(parseFloat32(b, 20));
      await this._setCapSafe('max_current', maxCurrVal);
      if (this._lbSetpointA === null && maxCurrVal >= 6) {
        const hwMax = Number(this._settings.max_current_limit) || 16;
        this._lbSetpointA = Math.min(maxCurrVal, hwMax);
        this._userMaxA    = Math.min(maxCurrVal, hwMax); // initialize user max from charger
      }

      // Safe current (offset 24, 2 regs FLOAT32) → regs 1212-1213
      await this._setCapSafe('safe_current', this._clean(parseFloat32(b, 24)));

      // Setpoint accounted for (offset 28, 1 reg UNSIGNED16) → reg 1214
      if (LOG) this.log(`Setpoint accounted: ${b.readUInt16BE(28) === 1 ? 'yes' : 'no'}`);

      // Charge phases (offset 30, 1 reg UNSIGNED16) → reg 1215
      await this._setCapSafe('charge_phases', b.readUInt16BE(30) === 3 ? '3' : '1');

    } catch (err) { this.log('pollSocketStatus err:', err.message); }
  }

  async _pollMeasurements() {
    try {
      const res = await this._clientSocket1.readHoldingRegisters(REG_VOLTAGE_L1, 6);
      const b   = res.response._body.valuesAsBuffer;
      await this._setCapSafe('measure_voltage.L1', this._clean(parseFloat32(b, 0)));
      await this._setCapSafe('measure_voltage.L2', this._clean(parseFloat32(b, 4)));
      await this._setCapSafe('measure_voltage.L3', this._clean(parseFloat32(b, 8)));
    } catch (err) { this.log('pollVoltage err:', err.message); }

    try {
      const res = await this._clientSocket1.readHoldingRegisters(REG_CURRENT_L1, 6);
      const b   = res.response._body.valuesAsBuffer;
      const cL1 = this._clean(parseFloat32(b, 0));
      const cL2 = this._clean(parseFloat32(b, 4));
      const cL3 = this._clean(parseFloat32(b, 8));
      await this._setCapSafe('measure_current.L1', cL1);
      await this._setCapSafe('measure_current.L2', cL2);
      await this._setCapSafe('measure_current.L3', cL3);
      // Keep actual charger current fresh for LB calculation
      this._chargerCurrentA = { L1: cL1, L2: cL2, L3: cL3 };
    } catch (err) { this.log('pollCurrent err:', err.message); }

    try {
      const res = await this._clientSocket1.readHoldingRegisters(REG_POWER_L1, 8);
      const b   = res.response._body.valuesAsBuffer;
      await this._setCapSafe('measure_power.L1', this._clean(parseFloat32(b, 0)));
      await this._setCapSafe('measure_power.L2', this._clean(parseFloat32(b, 4)));
      await this._setCapSafe('measure_power.L3', this._clean(parseFloat32(b, 8)));
      await this._setCapSafe('measure_power',    this._clean(parseFloat32(b, 12)));
    } catch (err) { this.log('pollPower err:', err.message); }

    try {
      const res = await this._clientSocket1.readHoldingRegisters(REG_ENERGY_SUM, 4);
      await this._setCapSafe('meter_power', this._clean(parseFloat64(res.response._body.valuesAsBuffer) / 1000));
    } catch (err) { this.log('pollEnergy err:', err.message); }
  }

  // ── Write operations ──────────────────────────────────────────────────────

  // ── Pause / resume ───────────────────────────────────────────────────────
  //
  // Pausing sets the charge current to PAUSE_CURRENT_A (5 A). At this level
  // the IEC 61851 pilot signal stays active (session intact) but the current
  // is below the IEC 61851 minimum (6A) so the car stops drawing power.
  //
  // The LB calculation returns PAUSE_CURRENT_A immediately when _paused=true,
  // so the keepalive timer keeps writing 3 A and the Alfen validity timer
  // never expires. On resume the pre-pause setpoint is restored and LB
  // immediately recalculates using the current grid data.

  async _pauseCharging() {
    if (this._paused) return; // already paused

    // Save current setpoint so resume can restore it
    this._prePauseSetpointA = this._lbSetpointA;
    this._paused            = true;

    this.log(`Charging paused — writing ${PAUSE_CURRENT_A} A`);

    if (this._socketConnected) {
      await this._writeMaxCurrentRaw(PAUSE_CURRENT_A);
      await this._setCapSafe('max_current', PAUSE_CURRENT_A);
    }
    this._lbSetpointA = PAUSE_CURRENT_A;

    await this._setCapSafe('evcharger_charging', false);

    // Fire pause trigger
    this.homey.flow.getDeviceTriggerCard('charging_paused')
      .trigger(this).catch(this.error.bind(this));
  }

  async _resumeCharging() {
    if (!this._paused) return; // not paused

    this._paused = false;
    this.log('Charging resumed');

    // Restore pre-pause setpoint, then immediately recalculate
    if (this._prePauseSetpointA !== null) {
      this._lbSetpointA = this._prePauseSetpointA;
      this._userMaxA    = this._prePauseSetpointA; // restore user max too
    }
    this._prePauseSetpointA = null;

    // Recalculate immediately using current grid data (or setpoint if no meter)
    if (this._socketConnected) {
      const setpoint = this._calculateLbSetpoint();
      this._lbSetpointA = setpoint;
      await this._writeMaxCurrentRaw(setpoint);
      await this._setCapSafe('max_current', setpoint);
    }

    await this._setCapSafe('evcharger_charging', isActivelyCharging(this._lastMode3));

    // Fire resume trigger
    this.homey.flow.getDeviceTriggerCard('charging_resumed')
      .trigger(this).catch(this.error.bind(this));
  }

  _startValidTimeCountdown(initialSeconds) {
    this._stopValidTimeCountdown();
    let remaining = Math.max(0, Math.round(initialSeconds));
    this._validTimeCountdown = this.homey.setInterval(async () => {
      remaining = Math.max(0, remaining - 5);
      await this._setCapSafe('valid_time_remaining', remaining);
      if (remaining <= 0) this._stopValidTimeCountdown();
    }, 5000);
  }

  _stopValidTimeCountdown() {
    if (this._validTimeCountdown) {
      this.homey.clearInterval(this._validTimeCountdown);
      this._validTimeCountdown = null;
    }
  }

  async _writeMaxCurrentRaw(amps) {
    const [lowWord, highWord] = encodeFloat32(amps);
    await this._clientSocket1.writeMultipleRegisters(REG_MAX_CURRENT_RW, [lowWord, highWord]);
  }

  async _writeMaxCurrentDirect(amps) {
    if (!this._socketConnected) throw new Error(this.homey.__('errors.not_connected'));
    const cableMax = Number(this._settings.max_current_limit) || 16;
    if (amps < 6 || amps > cableMax) throw new Error(`Current must be 6–${cableMax} A`);

    // Explicit current command always clears the pause state — the user is
    // consciously overriding, so treat it as an implicit resume.
    if (this._paused) {
      this.log(`Direct current command (${amps} A) clears pause state`);
      this._paused            = false;
      this._prePauseSetpointA = null;
      await this._setCapSafe('evcharger_charging', isActivelyCharging(this._lastMode3));

      // Notify the user that the pause was cleared by a manual current change
      this.homey.notifications.createNotification({
        excerpt: this.homey.__('notifications.pause_cleared_by_slider', { amps }),
      }).catch(err => this.log('Notification error:', err.message));
    }

    await this._writeMaxCurrentRaw(amps);
    this._lbSetpointA = amps;
    this._userMaxA    = amps; // remember as user's desired maximum
    await this.delay(300);
    const res  = await this._clientSocket1.readHoldingRegisters(REG_MAX_CURRENT_RW, 2);
    await this._setCapSafe('max_current', this._clean(parseFloat32(res.response._body.valuesAsBuffer)));
  }

  async _writePhases(phases) {
    if (!this._socketConnected) throw new Error(this.homey.__('errors.not_connected'));
    if (phases !== 1 && phases !== 3) throw new Error('Phases must be 1 or 3');
    await this._clientSocket1.writeSingleRegister(REG_PHASES, phases);
    await this._setCapSafe('charge_phases', String(phases));
  }

  _applyCurrentLimits() {
    const hwMax = Math.min(Math.max(Number(this._settings.max_current_limit) || 16, 6), 32);
    this.setCapabilityOptions('max_current', { min: 6, max: hwMax, step: 1 })
      .catch(err => this.log('setCapabilityOptions err:', err.message));
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  async _setCapSafe(cap, value) {
    try {
      if (!this.hasCapability(cap) || this.getCapabilityValue(cap) === value) return;
      await this.setCapabilityValue(cap, value);
    } catch (err) { this.log(`setCapabilityValue(${cap}) err:`, err.message); }
  }

  _clean(val) {
    if (!isFinite(val) || isNaN(val) || Math.abs(val) > 1e10) return 0;
    return Math.round(val * 100) / 100;
  }

  delay(ms) { return new Promise(r => this.homey.setTimeout(r, ms)); }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async onAdded() { this.log('Device added:', this.getData().id); }

  async onDeleted() {
    this.log('Device deleted:', this.getData().id);
    this._destroyMeterListeners();
    this._stopLoadBalancing();
    this._stopValidTimeCountdown();
    if (this._pollingTimer) { this.homey.clearInterval(this._pollingTimer); this._pollingTimer = null; }
    this._socket.destroy();
  }

  async onUninit() {
    this.log('Device uninit:', this.getData().id);
    this._destroyMeterListeners();
    this._stopLoadBalancing();
    this._stopValidTimeCountdown();
    if (this._pollingTimer) { this.homey.clearInterval(this._pollingTimer); this._pollingTimer = null; }
    await this._disconnect().catch(() => {});
  }
};