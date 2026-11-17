'use strict';

const Homey  = require('homey');
const net    = require('net');
const Modbus = require('jsmodbus');

// ─── Timing ───────────────────────────────────────────────────────────
const POLL_INTERVAL_MS      = 30 * 1000;
const RECONNECT_DELAY_MS    =  5 * 1000;
const CONNECT_TIMEOUT_MS    =  8 * 1000;
const LB_INTERVAL_DEFAULT_S = 30;
const LB_INTERVAL_MIN_S     = 10;
const ALFEN_VALIDITY_TIME_S = 60;
const PAUSE_CURRENT_A       =  5;
const METER_DEBOUNCE_MS     =  3 * 1000;  // meter-events samenvoegen tot max. 1 herberekening per 3 s
const DISCONNECT_TIMEOUT_MS =  2 * 1000;

// ─── Laadregeling (rustig starten, niet pendelen) ─────────────────────────────
const MIN_CHARGE_DEFAULT_A  =  7;               // standaard instelling 'min_charge_current'
const RESUME_MIN_A          =  8;               // startstroom na een (interne) pauze
const RESUME_HOLD_MS        = 90 * 1000;        // startstroom zo lang vasthouden
const RAISE_STEP_A          =  2;               // verhogen pas bij minimaal deze ruimte extra
const RAISE_STABLE_MS       = 60 * 1000;        // ... die zo lang aaneengesloten aanwezig is
const SETTLE_MS             = 15 * 1000;        // na een wijziging: auto tijd geven om bij te regelen
const AUTO_PAUSE_MIN_MS     =  5 * 60 * 1000;   // minimale duur interne pauze
const CHARGE_MIN_MS         =  5 * 60 * 1000;   // minimale laadduur voordat zonneladen mag pauzeren
const CHARGER_READ_MAX_AGE_MS = 2 * 1000;       // laadstroom paal verversen als ouder dan dit

// ─── Alfen Modbus server addresses ───────────────────────────────────────────
const UNIT_SOCKET1 =   1;

// ─── Register addresses ──────────────────────────────────────────────────────
const REG_MODE3_BULK          = 1200;
const REG_ACTUAL_MAX_A        = 1206;
const REG_VALID_TIME_LEFT     = 1208;
const REG_MAX_CURRENT_RW      = 1210;
const REG_SAFE_CURRENT        = 1212;
const REG_PHASES              = 1215;
const REG_SETPOINT_ACCOUNTED  = 1214;
const REG_VOLTAGE_L1          =  306;
const REG_CURRENT_L1          =  320;
const REG_POWER_L1            =  338;
const REG_ENERGY_SUM          =  374;
// Eén blok-read 306..377 dekt spanning, stroom, vermogen en energie (72 registers)
const REG_METER_BLOCK_START   =  306;
const REG_METER_BLOCK_LEN     =   72;

const LOG = true;

// ─── Mode3 helpers ────────────────────────────────────────────────────────
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

// ─── Float helpers ────────────────────────────────────────────────────────
function parseFloat32(buf, offset = 0) {
  return buf.readFloatBE(offset);
}
function encodeFloat32(value) {
  const b = Buffer.alloc(4);
  b.writeFloatBE(value, 0);
  return [b.readUInt16BE(0), b.readUInt16BE(2)];
}
function parseFloat64(buf, offset = 0) {
  return buf.readDoubleBE(offset);
}
function parseString(buf, offset, numRegs) {
  let s = '';
  for (let i = 0; i < numRegs * 2; i++) {
    const c = buf[offset + i]; if (c === 0) break; s += String.fromCharCode(c);
  }
  return s.trim();
}

// ─── Device ──────────────────────────────────────────────────────────
module.exports = class AlfenAceDevice extends Homey.Device {

  async onInit() {
    this.log(`Device init: ${this.getName()} (${this.getData().id})`);

    this._settings = this.getSettings();

    await this._setCapSafe('meter_active', false);
    await this._setCapSafe('car_connected', false);
    await this._setCapSafe('charging_paused', false);
    await this._setCapSafe('solar_mode_active', false);

    const settingDefaults = {
      grid_phases:          '3',
      grid_fuse_A:           25,
      max_current_limit:     16,
      meter_device_id:       '',
      lb_enabled:          true,
      lb_interval:           30,
      lb_safety_margin_A:     1,
      single_phase_solar:  false,
      power_source:     'phases',
      min_charge_current:  MIN_CHARGE_DEFAULT_A,
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

    this._socketConnected   = false;
    this._pollingTimer      = null;
    this._lbTimer           = null;
    this._meterStatusTimer  = null;
    this._reconnecting      = false;
    this._reconnectAttempts = 0;
    this._lastMode3         = null;
    this._lbSetpointA       = null;
    this._carConnected      = false;
    this._chargingPaused    = false;
    this._solarModeActive   = false;
    // Herstel opgeslagen gebruikerslimiet — blijft zo bewaard over herstarts heen.
    const savedUserMaxA = this.getStoreValue('userMaxA');
    this._userMaxA = (typeof savedUserMaxA === 'number' && savedUserMaxA >= 6)
      ? savedUserMaxA : null;
    this._paused            = false;
    this._prePauseSetpointA = null;
    this._gridCurrentA      = { L1: null, L2: null, L3: null };
    this._gridLastUpdateMs  = null;
    this._meterConfigured   = false;
    this._meterHasData      = false;
    this._meterActive       = false;
    this._validTimeCountdown = null;
    this._chargerCurrentA   = { L1: 0, L2: 0, L3: 0 };
    this._meterCapInstances = [];
    this._meterRefreshFn        = null;
    this._solarModeEnabled      = false;
    this._solarMinChargeKw      = this.hasCapability('solar_min_charge_kw')
      ? (this.getCapabilityValue('solar_min_charge_kw') || 0)
      : 0;
    this._activeChargePhases    = null;  // wordt bij eerste solar-cyclus ingesteld
    this._lastPhaseSwitchMs     = 0;

    // Laadregeling: interne pauze (zekering/zon) staat los van de pauze van de gebruiker
    this._autoPaused            = false;
    this._autoPausedSince       = 0;
    this._autoPauseReason       = null;
    this._holdUntil             = 0;      // tot wanneer de startstroom wordt vastgehouden
    this._chargeStartMs         = 0;      // start van de huidige laadperiode
    this._lastWriteMs           = 0;      // laatste wijziging van het instelpunt
    this._chargerReadMs         = 0;      // laatste uitlezing laadstroom paal
    this._stable                = { start: null, raise: null };

    // Lifecycle / concurrency
    this._destroyed             = false;
    this._reconnectTimer        = null;
    this._recalcTimer           = null;
    this._lock                  = Promise.resolve();
    this._pollBusy              = false;
    this._attachSeq             = 0;
    this._meterBlockSupported   = true;

    this._applyCurrentLimits();
    this._validateLbInterval();

    this._socket        = new net.Socket();
    this._clientSocket1 = new Modbus.client.TCP(this._socket, UNIT_SOCKET1);

    this._socket.setKeepAlive(true);
    this._socket.setMaxListeners(20);

    this._socket.on('connect', () => {
      if (this._destroyed) { this._socket.destroy(); return; }
      this._socketConnected   = true;
      this._reconnecting      = false;
      this._reconnectAttempts = 0;
      this.log('Socket connected');
      this.setAvailable().catch(() => {});
    });
    this._socket.on('end',     () => this.log('Socket ended'));
    this._socket.on('timeout', () => { this.log('Socket timeout'); this._socket.destroy(); });
    this._socket.on('error',   err => this.log('Socket error:', err.message));
    this._socket.on('close', () => {
      this._socketConnected = false;
      if (this._destroyed) return;
      this.log('Socket closed');
      this.setUnavailable(this.homey.__('device.disconnected')).catch(() => {});
      this._scheduleReconnect();
    });

    // ── Capability listeners ─────────────────────────────────────────────────
    this.registerCapabilityListener('max_current', value =>
      this._exclusive(() => this._writeMaxCurrentDirect(value)));
    this.registerCapabilityListener('evcharger_charging', value => this._exclusive(async () => {
      this.log(`Pause state requested: ${value ? 'OFF' : 'ON'} (toggle from Homey UI)`);
      if (value) {
        await this._resumeCharging();
      } else {
        await this._pauseCharging();
      }
    }));
    this.registerCapabilityListener('charge_phases', value =>
      this._exclusive(() => this._writePhases(Number(value))));
    this.registerCapabilityListener('solar_mode', enabled => this._exclusive(async () => {
      this.log(`Solar charging toggle requested: ${enabled ? 'ON' : 'OFF'}`);
      this._solarModeEnabled = enabled;
      this._solarModeActive = enabled;
      await this._setCapSafe('solar_mode_active', enabled);
      if (enabled) {
        const phases = Number(this._settings.grid_phases) || 3;
        const hasL1  = this._gridCurrentA.L1 !== null;
        const hasAll = phases === 1
          ? hasL1
          : (hasL1 && this._gridCurrentA.L2 !== null && this._gridCurrentA.L3 !== null);

        if (!hasAll) {
          this._solarModeEnabled = false;
          this._solarModeActive = false;
          await this._setCapSafe('solar_mode_active', false);
          await this._setCapSafe('solar_mode', false);
          const msg = this.homey.__('warnings.solar_requires_phase_current');
          this.log(`Solar mode geblokkeerd: per-fase stroomdata ontbreekt (L1=${this._gridCurrentA.L1}, L2=${this._gridCurrentA.L2}, L3=${this._gridCurrentA.L3})`);
          this.setWarning(msg).catch(() => {});
          return;
        }
      }

      this.log(`Solar charging state set to ${enabled ? 'ON' : 'OFF'}`);
      if (!enabled) {
        // Stond zonneladen in een interne pauze, dan mag de loadbalancing meteen
        // (na 60 s stabiele ruimte) weer starten: de minimale pauzeduur vervalt.
        if (this._autoPaused) this._autoPausedSince = 0;
        this._activeChargePhases = null;
        this._lastPhaseSwitchMs  = 0;
        this.unsetWarning().catch(() => {});
        this.homey.notifications.createNotification({
          excerpt: this.homey.__('notifications.solar_mode_disabled'),
        }).catch(err => this.log('Notification error:', err.message));
      } else {
        this.homey.notifications.createNotification({
          excerpt: this.homey.__('notifications.solar_mode_enabled'),
        }).catch(err => this.log('Notification error:', err.message));
        await this._handleSolarMode();
      }
    }));
    this.registerCapabilityListener('solar_min_charge_kw', value => this._exclusive(async () => {
      this._solarMinChargeKw = value;
      const phases = Number(this._settings.grid_phases) || 3;
      this.log(`Solar minimale laadsnelheid: ${value} kW (${(value * 1000 / (phases * 230)).toFixed(1)} A/fase)`);
      if (this._solarModeEnabled && this._gridCurrentA.L1 !== null) {
        await this._handleSolarMode();
      }
    }));

    // Flow-kaarten worden in driver.js geregistreerd (één keer, met args.device).

    // ── Connect + start timers ───────────────────────────────────────────────
    await this.delay(1500);
    try {
      await this._connect();
    } catch (err) {
      this.log('Initial connect failed:', err.message);
      this.setUnavailable(this.homey.__('device.disconnected')).catch(() => {});
    }

    this._startPolling();
    this._startLoadBalancing();
    this._attachMeterListeners().catch(e => this.log('Meter attach err:', e.message));
  }

  // ── Flow API (aangeroepen vanuit driver.js) ────────────────────────────────
  flowUpdateGridCurrent(l1, l2, l3) { return this._exclusive(() => this._updateGridCurrent(l1, l2, l3)); }
  flowSetMaxCurrent(amps)           { return this._exclusive(() => this._writeMaxCurrentDirect(amps)); }
  flowPauseCharging()               { return this._exclusive(() => this._pauseCharging()); }
  flowResumeCharging()              { return this._exclusive(() => this._resumeCharging()); }
  flowSetChargePhases(phases)       { return this._exclusive(() => this._writePhases(phases)); }
  async flowSetSolarMode(enable) {
    // De capability listener (zelf al exclusief) zet zonneladen weer uit als per-fase meterdata ontbreekt
    await this.triggerCapabilityListener('solar_mode', enable);
    if (enable && !this._solarModeEnabled) {
      await this.setCapabilityValue('solar_mode', false).catch(() => {});
      throw new Error(this.homey.__('warnings.solar_requires_phase_current'));
    }
  }
  flowIsCharging()     { return isActivelyCharging(this._lastMode3); }
  flowIsCarConnected() { return isCarConnected(this._lastMode3); }
  flowIsPaused()       { return !!this._paused; }
  flowIsSolarMode()    { return !!this._solarModeEnabled; }

  // ── Concurrency helpers ──────────────────────────────────────────────────
  // Serialiseert alle state-wijzigende/schrijvende paden, zodat bv. pauze,
  // faseomschakeling en zonneladen elkaar niet halverwege kruisen.
  _exclusive(fn) {
    const run = this._lock.then(() => (this._destroyed ? undefined : fn()));
    this._lock = run.catch(() => {});
    return run;
  }

  // Voegt de 3-4 meter-events per update samen tot één herberekening.
  _scheduleRecalc() {
    if (this._destroyed || this._recalcTimer) return;
    this._recalcTimer = this.homey.setTimeout(() => {
      this._recalcTimer = null;
      this._exclusive(() => (this._solarModeEnabled ? this._handleSolarMode() : this._recalculateAndWrite()))
        .catch(e => this.log('Recalc err:', e.message));
    }, METER_DEBOUNCE_MS);
  }

  // ── Energy meter listeners (HomeyAPI) ─────────────────────────────────────
  async _attachMeterListeners(retryCount = 0) {
    if (this._destroyed) return;
    this._destroyMeterListeners();
    const seq = ++this._attachSeq;   // nieuwere attach maakt deze ongeldig
    const stillCurrent = () => !this._destroyed && seq === this._attachSeq;

    const deviceId = (this._settings.meter_device_id || '').trim();
    if (!deviceId) {
      this.log('No meter_device_id configured — using flow action for grid current');
      return;
    }

    const homeyApi = this.homey.app.homeyApi;
    if (!homeyApi) {
      this.log('HomeyAPI not available — cannot attach meter listeners');
      this.setWarning('HomeyAPI not available — check app permissions').catch(() => {});
      if (retryCount < 5) {
        const delay = Math.min(5000 * Math.pow(2, retryCount), 60000);
        this.log(`Retrying meter attach in ${delay/1000}s (attempt ${retryCount + 1}/5)`);
        this.homey.setTimeout(() => {
          if (!stillCurrent()) return;
          this._attachMeterListeners(retryCount + 1)
            .catch(e => this.log('Meter attach retry err:', e.message));
        }, delay);
      }
      return;
    }

    let meterDevice;
    try {
      meterDevice = await homeyApi.devices.getDevice({ id: deviceId });
    } catch (err) {
      if (!stillCurrent()) return;
      this.log(`Meter device '${deviceId}' not found: ${err.message}`);
      if (retryCount < 3) {
        const delay = Math.min(10000 * Math.pow(2, retryCount), 60000);
        this.log(`Retrying meter attach in ${delay/1000}s (attempt ${retryCount + 1}/3)`);
        this.homey.setTimeout(() => {
          if (!stillCurrent()) return;
          this._attachMeterListeners(retryCount + 1)
            .catch(e => this.log('Meter attach retry err:', e.message));
        }, delay);
        return;
      }
      this.setWarning(this.homey.__('warnings.meter_device_not_found')).catch(() => {});
      return;
    }
    if (!stillCurrent()) return;   // intussen verwijderd of opnieuw gekoppeld

    const numPhases = Number(this._settings.grid_phases) || 3;
    const wantedCaps = numPhases === 1
      ? ['measure_current.l1']
      : ['measure_current.l1', 'measure_current.l2', 'measure_current.l3'];
    const allCapKeys = Object.keys(meterDevice.capabilitiesObj || {});
    const resolvecap = name => allCapKeys.find(k => k.toLowerCase() === name) || null;
    const currentCaps = wantedCaps.map(resolvecap).filter(Boolean);
    const powerCap    = allCapKeys.find(k => k === 'measure_power') || null;
    const available   = [...currentCaps, ...(powerCap ? [powerCap] : [])];

    if (available.length === 0) {
      this.log(`Meter device has none of: ${wantedCaps.join(', ')} — available current caps:`,
        allCapKeys.filter(c => c.toLowerCase().includes('current') || c.toLowerCase().includes('power')));
      this.setWarning(this.homey.__('warnings.meter_capability_missing')).catch(() => {});
      this._meterConfigured = true;
      this._meterHasData    = false;
      return;
    }

    this.setWarning(this.homey.__('warnings.meter_waiting_for_data')).catch(() => {});
    this._meterHasData = false;
    this._meterActive  = false;
    this._setCapSafe('meter_active', false).catch(() => {});
    this.log(`Attaching meter listeners on '${meterDevice.name}' for: ${available.join(', ')}`);

    const capEntries = [];
    for (const cap of available) {
      const capLower = cap.toLowerCase();
      const instance = meterDevice.makeCapabilityInstance(cap, value => {
        if (this._destroyed) return;
        this._applyMeterValue(capLower, value);
      });
      this._meterCapInstances.push(instance);
      capEntries.push({ cap, capLower });

      const capObj = (meterDevice.capabilitiesObj || {})[cap];
      const initialValue = (capObj != null) ? capObj.value : null;
      if (initialValue !== null && initialValue !== undefined) {
        this.log(`Initial meter value ${cap}: ${initialValue}`);
        this._applyMeterValue(capLower, initialValue);
      }
    }

    this._meterRefreshFn = () => {
      let anyFresh = false;
      for (const { cap, capLower } of capEntries) {
        const capObj2 = (meterDevice.capabilitiesObj || {})[cap];
        const val = (capObj2 != null) ? capObj2.value : null;
        if (val !== null && val !== undefined) {
          if (capLower === 'measure_current.l1') this._gridCurrentA.L1 = val;
          if (capLower === 'measure_current.l2') this._gridCurrentA.L2 = val;
          if (capLower === 'measure_current.l3') this._gridCurrentA.L3 = val;
          if (capLower === 'measure_power') {
            if (this.hasCapability('grid_power')) {
              this.setCapabilityValue('grid_power', Math.round(val)).catch(() => {});
            }
          }
          anyFresh = true;
        }
      }
      if (anyFresh) this._gridLastUpdateMs = Date.now();
    };

    this._meterConfigured = true;
    this.log(`Meter listeners active (${this._meterCapInstances.length} capabilities)`);
  }

  _applyMeterValue(capLower, value) {
    if (capLower === 'measure_current.l1') this._gridCurrentA.L1 = value;
    if (capLower === 'measure_current.l2') this._gridCurrentA.L2 = value;
    if (capLower === 'measure_current.l3') this._gridCurrentA.L3 = value;
    if (capLower === 'measure_power') {
      this._setCapSafe('grid_power', Math.round(value)).catch(() => {});
    }
    this._gridLastUpdateMs = Date.now();
    if (!this._meterHasData) {
      this._meterHasData = true;
      this._meterActive  = true;
      this.unsetWarning().catch(() => {});
      this._setCapSafe('meter_active', true).catch(() => {});
      this.log('Meter data received — warning cleared');
    }
    if (capLower === 'measure_power') return;
    this._scheduleRecalc();
  }

  _destroyMeterListeners() {
    for (const inst of this._meterCapInstances) {
      try { inst.destroy(); } catch (_) {}
    }
    this._meterCapInstances = [];
    this._meterRefreshFn    = null;
    this._meterHasData      = false;
    this._meterActive       = false;
    this._setCapSafe('meter_active', false).catch(() => {});
  }

  // ── Laadregeling: grenzen ──────────────────────────────────────────────────
  // Hoogste stroom die de gebruiker toestaat (schuif/flowkaart, begrensd door kabel/paal).
  _capA() {
    const cableMax = Number(this._settings.max_current_limit) || 16;
    return this._userMaxA !== null ? Math.min(this._userMaxA, cableMax) : cableMax;
  }

  // Laagste stroom waarop geladen wordt. Kiest de gebruiker zelf een lager maximum
  // (bijv. 6 A), dan respecteren we dat.
  _effectiveMinA() {
    const v = Number(this._settings.min_charge_current);
    const minA = (v >= 6 && v <= 16) ? v : MIN_CHARGE_DEFAULT_A;
    return Math.min(minA, this._capA());
  }

  _effectiveResumeA() {
    return Math.max(this._effectiveMinA(), Math.min(RESUME_MIN_A, this._capA()));
  }

  // Laadstroom van de paal per fase, zoals meegerekend in de ruimte op de zekering.
  _chargerCurrentForCalc() {
    const fallbackA = (isActivelyCharging(this._lastMode3) && this._lbSetpointA > PAUSE_CURRENT_A)
      ? this._lbSetpointA : 0;
    return {
      L1: this._chargerCurrentA.L1 > 0 ? this._chargerCurrentA.L1 : fallbackA,
      L2: this._chargerCurrentA.L2 > 0 ? this._chargerCurrentA.L2 : fallbackA,
      L3: this._chargerCurrentA.L3 > 0 ? this._chargerCurrentA.L3 : fallbackA,
    };
  }

  // Ruimte op de hoofdzekering voor de lader (A per fase), zonder ondergrens.
  _fuseRoomA(phases) {
    const fuseA    = Number(this._settings.grid_fuse_A)        || 25;
    const cableMax = Number(this._settings.max_current_limit)  || 16;
    const margin   = Number(this._settings.lb_safety_margin_A) ||  1;
    const chargerA = this._chargerCurrentForCalc();
    const avail = phase => {
      const measured = this._gridCurrentA[phase];
      if (measured === null) return cableMax;
      return fuseA - measured + (chargerA[phase] || 0) - margin;
    };
    const raw = phases === 1
      ? avail('L1')
      : Math.min(avail('L1'), avail('L2'), avail('L3'));
    return { raw, roomA: Math.min(Math.round(raw), cableMax), chargerA };
  }

  // Leest de actuele laadstroom van de paal als de laatste meting ouder is dan 2 s.
  // Zo rekent de loadbalancing niet met een laadstroom van tot 30 s oud terwijl de
  // netstroom al wel de nieuwe situatie laat zien (oorzaak van pendelen).
  async _refreshChargerCurrent() {
    if (!this._socketConnected || this._destroyed) return;
    if (Date.now() - this._chargerReadMs < CHARGER_READ_MAX_AGE_MS) return;
    try {
      const b = (await this._clientSocket1.readHoldingRegisters(REG_CURRENT_L1, 6)).response._body.valuesAsBuffer;
      const [cL1, cL2, cL3] = [0, 4, 8].map(o => this._clean(parseFloat32(b, o)));
      this._chargerCurrentA = { L1: cL1, L2: cL2, L3: cL3 };
      this._chargerReadMs   = Date.now();
    } catch (err) { this.log('refreshChargerCurrent err:', err.message); }
  }

  // Grenzen voor loadbalancing (niet-zonneladen).
  // Geeft { fallbackA } bij ontbrekende/verlopen meterdata, anders { wantA, roomA }.
  _computeLbLimits() {
    const staleMs   = (Number(this._settings.lb_interval) || 30) * 2 * 1000;
    const dataStale = this._gridLastUpdateMs !== null
      && (Date.now() - this._gridLastUpdateMs) > staleMs;
    const noDataYet = this._gridLastUpdateMs === null && this._meterConfigured;

    if (dataStale || noDataYet) {
      const currentSetpoint = this._lbSetpointA !== null ? this._lbSetpointA : 6;
      if (noDataYet) {
        this.log(`Wacht op eerste metermeting — huidige instelling ${currentSetpoint} A gehandhaafd`);
        return { fallbackA: currentSetpoint };
      }
      if (currentSetpoint <= 6) {
        this.log(`Meterdata verlopen — al op ${currentSetpoint} A (≤ 6 A veilig), geen wijziging`);
        return { fallbackA: currentSetpoint };
      }
      this.log('Meterdata verlopen — terugval naar 6 A veiligheidsniveau');
      return { fallbackA: 6 };
    }

    const capA = this._capA();
    if (!this._meterConfigured) return { wantA: capA, roomA: capA };

    const phases = Number(this._settings.grid_phases) || 3;
    const { raw, roomA, chargerA } = this._fuseRoomA(phases);
    if (LOG) this.log(`LB calc: charger=${JSON.stringify(chargerA)} ruimte=${raw.toFixed(1)} A → ${roomA} A, max=${capA} A`);
    return { wantA: capA, roomA };
  }

  // ── Laadregeling: centrale poort ───────────────────────────────────────────
  // Alle automatische schrijfacties (loadbalancing, keepalive, zonneladen) lopen hierdoor.
  //   wantA = gewenste stroom (LB: maximum gebruiker, zon: zondoel)
  //   roomA = ruimte op de hoofdzekering
  // Regels:
  //   - ruimte < minimum → interne pauze (5 A), de zekering gaat altijd voor
  //   - interne pauze eindigt pas na 5 min én 60 s stabiel ≥ startstroom
  //   - zondoel < minimum → eerst minimale laadduur afmaken, dan interne pauze
  //   - na (her)start 90 s de startstroom vasthouden (alleen omlaag voor de zekering)
  //   - omlaag direct, omhoog pas na 60 s stabiel ≥ 2 A extra en 15 s na de vorige wijziging
  async _applyTarget(wantA, roomA, src) {
    if (this._paused || !this._socketConnected || this._destroyed) return;
    const now  = Date.now();
    const minA = this._effectiveMinA();

    if (roomA < minA) {
      return this._autoPause(`te weinig ruimte op de zekering (${roomA} A)`);
    }

    if (this._autoPaused) {
      const availA = Math.min(wantA, roomA);
      const stable = this._stableAtLeast('start', availA, this._effectiveResumeA(), now);
      const longEnough = now - this._autoPausedSince >= AUTO_PAUSE_MIN_MS;
      if (!stable || !longEnough) return;
      this.log(`Interne pauze voorbij (${this._autoPauseReason}) — ${availA} A beschikbaar`);
      this._autoPaused      = false;
      this._autoPauseReason = null;
      return this._startCharging(wantA, roomA, src);
    }

    if (wantA < minA) {
      if (now - this._chargeStartMs < CHARGE_MIN_MS) {
        wantA = minA;   // minimale laadduur nog niet om: op minimum blijven
      } else {
        return this._autoPause(src === 'solar'
          ? `te weinig zon (${wantA} A)`
          : `gewenste stroom onder minimum (${wantA} A)`);
      }
    }

    let target = Math.min(wantA, roomA);
    if (now < this._holdUntil) {
      target = Math.max(target, Math.min(this._effectiveResumeA(), roomA));
    }

    const cur = this._lbSetpointA;
    if (cur !== null && target > cur) {
      const ok = this._stableAtLeast('raise', target, cur + RAISE_STEP_A, now);
      if (!ok || now - this._lastWriteMs < SETTLE_MS) return;
      target = this._stable.raise.minA;   // laagste waarde uit de afgelopen 60 s
      this._stable.raise = null;
    } else {
      this._stable.raise = null;
      // Vlak na een wijziging lopen netmeting en laadstroom van de paal nog niet synchroon.
      // Dan alleen verlagen als de zekering het echt vraagt.
      if (cur !== null && target < cur && now - this._lastWriteMs < SETTLE_MS && roomA >= cur) return;
    }

    if (target !== cur) await this._writeSetpoint(target, src);
  }

  // Houdt bij sinds wanneer 'value' aaneengesloten ≥ 'threshold' is en wat de laagste
  // waarde in die periode was. Geeft true als dat RAISE_STABLE_MS lang zo is.
  _stableAtLeast(key, value, threshold, now) {
    if (value < threshold) { this._stable[key] = null; return false; }
    const s = this._stable[key];
    if (!s) { this._stable[key] = { since: now, minA: value }; return false; }
    s.minA = Math.min(s.minA, value);
    return now - s.since >= RAISE_STABLE_MS;
  }

  // Start (of herstart) het laden: minimaal de startstroom, 90 s vasthouden.
  async _startCharging(wantA, roomA, src) {
    const minA = this._effectiveMinA();
    if (roomA < minA) {
      return this._autoPause(`te weinig ruimte op de zekering bij starten (${roomA} A)`);
    }
    const startA = Math.min(Math.max(Math.min(wantA, roomA), this._effectiveResumeA()), roomA);
    const now = Date.now();
    this._holdUntil     = now + RESUME_HOLD_MS;
    this._chargeStartMs = now;
    this._stable        = { start: null, raise: null };
    this.log(`Laden starten op ${startA} A (${RESUME_HOLD_MS / 1000} s vasthouden)`);
    await this._writeSetpoint(startA, src);
  }

  // Interne pauze: 5 A naar de paal, zonder de pauze-status/triggers van de gebruiker.
  async _autoPause(reason) {
    this._holdUntil = 0;
    this._stable    = { start: null, raise: null };
    if (!this._autoPaused) {
      this._autoPaused      = true;
      this._autoPausedSince = Date.now();
      this._autoPauseReason = reason;
      this.log(`Interne pauze: ${reason} — ${PAUSE_CURRENT_A} A naar de paal`);
    }
    if (this._lbSetpointA !== PAUSE_CURRENT_A) await this._writeSetpoint(PAUSE_CURRENT_A, 'pause');
  }

  _clearAutoPause() {
    this._autoPaused      = false;
    this._autoPauseReason = null;
    this._holdUntil       = 0;
    this._stable          = { start: null, raise: null };
  }

  async _writeSetpoint(amps, src) {
    const prev = this._lbSetpointA;
    await this._writeMaxCurrentRaw(amps);
    this._lbSetpointA = amps;
    this._lastWriteMs = Date.now();
    this._chargerReadMs = 0;   // na een wijziging bij de volgende berekening opnieuw uitlezen
    await this._setCapSafe('max_current', amps);
    this.log(`Instelpunt (${src}): ${prev} → ${amps} A`);
  }

  async _handleSolarMode() {
    if (!this._solarModeEnabled || this._paused) return;   // pauze van de gebruiker gaat voor
    await this._refreshChargerCurrent();
    const gridPhases = Number(this._settings.grid_phases)       || 3;

    let surplusW = 0;
    for (let ph = 1; ph <= gridPhases; ph++) {
      const key = `L${ph}`;
      surplusW += (-(this._gridCurrentA[key] || 0) + (this._chargerCurrentA[key] || 0)) * 230;
    }
    const surplusKw = surplusW / 1000;

    const minimumKw = this._solarMinChargeKw;
    const targetKw  = Math.max(minimumKw, surplusKw);

    const THREE_PHASE_MIN_KW = Math.round(6 * 3 * 230 / 100) / 10;
    const canAutoSwitch = gridPhases === 3 && !!this._settings.single_phase_solar;
    let activePhases = canAutoSwitch
      ? (targetKw >= THREE_PHASE_MIN_KW ? 3 : 1)
      : gridPhases;

    const currentPhases = this._activeChargePhases !== null ? this._activeChargePhases : gridPhases;
    if (this._activeChargePhases === null) {
      this._activeChargePhases = activePhases;
      this._lastPhaseSwitchMs  = 0;
      await this._writePhases(activePhases);
    } else if (activePhases !== currentPhases) {
      const elapsed = Date.now() - this._lastPhaseSwitchMs;
      if (elapsed < 60000) {
        this.log(`Solar: fasewisseling ${currentPhases}→${activePhases} uitgesteld (${Math.round((60000 - elapsed) / 1000)}s hysterese)`);
        activePhases = currentPhases;
      } else {
        this.log(`Solar: schakel ${currentPhases}→${activePhases} fase laden`);
        await this._writePhases(activePhases);
        this._activeChargePhases = activePhases;
        this._lastPhaseSwitchMs  = Date.now();
      }
    }

    const targetA_raw = (targetKw * 1000) / (activePhases * 230);
    const wantA = Math.round(targetA_raw);
    const { roomA } = this._fuseRoomA(activePhases);
    const shownA = Math.min(wantA, roomA);

    this.log(`Solar: overschot=${surplusKw.toFixed(1)} kW  minimum=${minimumKw.toFixed(1)} kW  fase=${activePhases}  doel=${shownA} A (${(shownA * activePhases * 230 / 1000).toFixed(1)} kW)  LB-ruimte=${roomA} A`);

    // Pauzeren/hervatten bij te weinig zon gaat via de interne pauze (niet via de
    // pauze van de gebruiker), met minimale laad- en pauzeduur. Zie _applyTarget.
    await this._applyTarget(wantA, roomA, 'solar');
  }

  async _recalculateAndWrite() {
    if (!this._socketConnected || this._destroyed || this._paused) return;
    await this._refreshChargerCurrent();
    const lim = this._computeLbLimits();
    if (lim.fallbackA !== undefined) {
      // Meterdata ontbreekt of is verlopen: bestaand veiligheidsgedrag (≤ 6 A).
      if (!this._autoPaused && lim.fallbackA !== this._lbSetpointA) {
        await this._writeSetpoint(lim.fallbackA, 'lb-fallback');
      }
      return;
    }
    await this._applyTarget(lim.wantA, lim.roomA, 'lb');
  }

  async _updateGridCurrent(l1, l2, l3) {
    this._gridCurrentA     = { L1: l1, L2: l2, L3: l3 };
    this._gridLastUpdateMs = Date.now();
    this._meterConfigured  = true;
    if (!this._meterHasData) {
      this._meterHasData = true;
      this._meterActive  = true;
      this.unsetWarning().catch(() => {});
      this._setCapSafe('meter_active', true).catch(() => {});
      this.log('Flow action grid current — meter_active gezet op true');
    }
    if (this._solarModeEnabled) {
      await this._handleSolarMode();
    } else {
      await this._recalculateAndWrite();
    }
  }

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
    if (!this._settings.lb_enabled) {
      this.log('LB keepalive disabled');
      if (!this._meterStatusTimer) {
        this._meterStatusTimer = this.homey.setInterval(() => {
          this._exclusive(() => this._lbKeepalive()).catch(e => this.log('Keepalive err:', e.message));
        }, 30000);
      }
      return;
    }
    if (this._meterStatusTimer) {
      this.homey.clearInterval(this._meterStatusTimer);
      this._meterStatusTimer = null;
    }
    const ms = this._lbIntervalMs();
    this.log(`LB keepalive started — ${ms / 1000} s interval`);
    this._lbTimer = this.homey.setInterval(() => {
      this._exclusive(() => this._lbKeepalive()).catch(e => this.log('Keepalive err:', e.message));
    }, ms);
  }

  _stopLoadBalancing() {
    if (this._lbTimer)        { this.homey.clearInterval(this._lbTimer);        this._lbTimer        = null; }
    if (this._meterStatusTimer) { this.homey.clearInterval(this._meterStatusTimer); this._meterStatusTimer = null; }
  }
  _restartLoadBalancing() { this._stopLoadBalancing(); this._startLoadBalancing(); }

  async _lbKeepalive() {
    if (this._destroyed) return;
    if (this._meterRefreshFn) this._meterRefreshFn();

    const staleMs   = (Number(this._settings.lb_interval) || 30) * 2 * 1000;
    const dataStale = this._gridLastUpdateMs !== null
      && (Date.now() - this._gridLastUpdateMs) > staleMs;
    const meterNowActive = this._meterConfigured && this._meterHasData && !dataStale;
    this._meterActive = meterNowActive;
    await this._setCapSafe('meter_active', meterNowActive);
    if (dataStale) {
      this.setWarning(this.homey.__('warnings.meter_data_stale')).catch(() => {});
    } else if (this._meterConfigured && this._meterHasData) {
      this.unsetWarning().catch(() => {});
    }

    const deviceId    = (this._settings.meter_device_id || '').trim();
    const longStaleMs = staleMs * 3;
    const longStale   = this._gridLastUpdateMs !== null
      && (Date.now() - this._gridLastUpdateMs) > longStaleMs;
    const neverHadData = this._meterConfigured && !this._meterHasData;
    if (deviceId && (longStale || neverHadData)) {
      this.log('Meter watchdog: re-attaching listeners (stale or no data)');
      this._attachMeterListeners().catch(e => this.log('Watchdog attach err:', e.message));
    }

    if (!this._socketConnected) return;
    try {
      if (this._paused) {
        // Pauze van de gebruiker: alleen 5 A herhalen (hieronder)
        if (this._lbSetpointA === null) this._lbSetpointA = PAUSE_CURRENT_A;
      } else if (this._solarModeEnabled) {
        if (dataStale || !this._meterHasData) {
          await this._autoPause('zonneladen: meterdata verlopen of ontbreekt');
        } else {
          await this._handleSolarMode();   // tijdregels (pauze-/laadduur) ook zonder meter-events
        }
      } else {
        await this._recalculateAndWrite();
      }
    } catch (err) {
      this.log(`Keepalive berekening mislukt: ${err.message}`);
    }

    // Alfen valt na 60 s zonder schrijfactie terug op safe current: instelpunt herhalen.
    // Dit herhaalt alleen de bestaande waarde, het is geen nieuwe beslissing.
    const a = (this._paused || this._autoPaused) ? PAUSE_CURRENT_A : this._lbSetpointA;
    if (a === null || Date.now() - this._lastWriteMs < 2000) return;
    try {
      await this._writeMaxCurrentRaw(a);
      if (LOG) this.log(`Keepalive herhaalde ${a} A`);
    } catch (err) {
      this.log(`Keepalive schrijffout: ${err.message}`);
    }
  }

  async _connect() {
    if (this._destroyed || this._socketConnected) return;
    return new Promise((resolve, reject) => {
      const { ip: host, port = 502 } = this._settings;
      this.log(`Connecting to ${host}:${port}`);
      const cleanup = () => {
        this.homey.clearTimeout(timer);
        this._socket.removeListener('connect', onConnect);
        this._socket.removeListener('error', onError);
      };
      const timer     = this.homey.setTimeout(() => { cleanup(); this._socket.destroy(); reject(new Error('Connection timeout')); }, CONNECT_TIMEOUT_MS);
      const onError   = err => { cleanup(); reject(err); };
      const onConnect = ()  => { cleanup(); resolve(); };
      this._socket.once('connect', onConnect);
      this._socket.once('error', onError);
      this._socket.connect(port, host);
    });
  }

  async _disconnect() {
    return new Promise(resolve => {
      if (!this._socketConnected) { resolve(); return; }
      // Niet eindeloos wachten op een nette close: na timeout hard sluiten.
      const timer = this.homey.setTimeout(() => this._socket.destroy(), DISCONNECT_TIMEOUT_MS);
      this._socket.once('close', () => { this.homey.clearTimeout(timer); resolve(); });
      this._socket.end();
    });
  }

  _scheduleReconnect() {
    if (this._destroyed || this._reconnecting) return;
    this._reconnecting = true;
    this._reconnectAttempts++;
    const delay = Math.min(RECONNECT_DELAY_MS * Math.pow(2, this._reconnectAttempts - 1), 30000);
    this.log(`Reconnect attempt ${this._reconnectAttempts} in ${delay / 1000}s`);
    this._reconnectTimer = this.homey.setTimeout(async () => {
      this._reconnectTimer = null;
      if (this._destroyed) return;
      try { await this._connect(); } catch (err) {
        if (this._destroyed) return;
        this.log('Reconnect failed:', err.message);
        this._reconnecting = false;
        this._scheduleReconnect();
      }
    }, delay);
  }

  async _checkMeterCapabilities(deviceId, phases) {
    const homeyApi = this.homey.app.homeyApi;
    if (!homeyApi) return { ok: true, missing: [] };

    let meterDevice;
    try {
      meterDevice = await homeyApi.devices.getDevice({ id: deviceId });
    } catch (_) {
      return { ok: false, missing: [this.homey.__('warnings.meter_device_not_found')] };
    }

    const allCapKeys = Object.keys(meterDevice.capabilitiesObj || {});
    const resolveCap = name => allCapKeys.find(k => k.toLowerCase() === name) || null;

    const required = phases === 1
      ? ['measure_current.l1']
      : ['measure_current.l1', 'measure_current.l2', 'measure_current.l3'];

    const missing = required.filter(cap => !resolveCap(cap));
    return { ok: missing.length === 0, missing };
  }

  async onSettings({ newSettings, changedKeys }) {
    const lbRelevant = changedKeys.some(k => ['lb_enabled', 'meter_device_id', 'grid_phases'].includes(k));
    if (lbRelevant && newSettings.lb_enabled && (newSettings.meter_device_id || '').trim()) {
      const check = await this._checkMeterCapabilities(
        newSettings.meter_device_id.trim(),
        Number(newSettings.grid_phases) || 3,
      );
      if (!check.ok) {
        const missing = check.missing.join(', ');
        const msg = this.homey.__('warnings.meter_capabilities_missing_lb', { missing });
        this.setWarning(msg).catch(() => {});
        throw new Error(msg);
      }
      this.homey.notifications.createNotification({
        excerpt: this.homey.__('notifications.lb_enabled_ok'),
      }).catch(err => this.log('Notification error:', err.message));
    }

    this._settings = newSettings;

    if (changedKeys.includes('max_current_limit') || changedKeys.includes('single_phase_solar')) {
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

  _startPolling() {
    this._runPoll().catch(err => this.log('Initial poll error:', err.message));
    this._pollingTimer = this.homey.setInterval(() => {
      if (!this._socketConnected) return;
      this._runPoll().catch(err => this.log('Poll error:', err.message));
    }, POLL_INTERVAL_MS);
  }

  // Voorkomt overlappende polls als de paal traag antwoordt.
  async _runPoll() {
    if (this._pollBusy || this._destroyed) return;
    this._pollBusy = true;
    try {
      await this._exclusive(() => this._pollAll());
    } finally {
      this._pollBusy = false;
    }
  }

  async _pollAll() {
    await this._pollSocketStatus();
    await this._pollMeasurements();
  }

  async _pollSocketStatus() {
    try {
      const res = await this._clientSocket1.readHoldingRegisters(REG_MODE3_BULK, 16);
      const b   = res.response._body.valuesAsBuffer;

      const staleMs2    = (Number(this._settings.lb_interval) || 30) * 2 * 1000;
      const dataIsStale = this._gridLastUpdateMs !== null
        && (Date.now() - this._gridLastUpdateMs) > staleMs2;
      const isActive = this._meterConfigured && this._meterHasData && !dataIsStale;
      if (isActive !== this._meterActive) this._meterActive = isActive;
      await this._setCapSafe('meter_active', isActive);

      const mode3 = parseString(b, 2, 5) || 'A';
      const prev  = this._lastMode3;
      const carConnected = isCarConnected(mode3);
      if (prev !== null) {
        if (!isCarConnected(prev) && carConnected) {
          this.log('Car connected');
          this.homey.flow.getDeviceTriggerCard('car_connected').trigger(this).catch(this.error.bind(this));
        }
        if (isCarConnected(prev) && !carConnected) {
          this.log('Car disconnected');
          this.homey.flow.getDeviceTriggerCard('car_disconnected').trigger(this).catch(this.error.bind(this));
          this.log('Car disconnected: clearing pause and solar charging');
          if (this._autoPaused) {
            this._clearAutoPause();
            this._lbSetpointA = null;   // volgende berekening schrijft direct een nieuw instelpunt
          }
          this._holdUntil     = 0;
          this._chargeStartMs = 0;
          if (this._paused) {
            this._paused = false;
            this._prePauseSetpointA = null;
            this._lbSetpointA = null;
            this.log('Car disconnected: pause state set to OFF');
            this.homey.notifications.createNotification({
              excerpt: this.homey.__('notifications.pause_cleared_on_disconnect'),
            }).catch(err => this.log('Notification error:', err.message));
            await this._setCapSafe('evcharger_charging', false);
            await this._setCapSafe('evcharger_charging_state', 'plugged_out');
            await this._setCapSafe('charging_paused', false);
          }
          if (this._solarModeEnabled) {
            this._solarModeEnabled = false;
            this._solarModeActive = false;
            this._activeChargePhases = null;
            this._lastPhaseSwitchMs = 0;
            await this._setCapSafe('solar_mode', false);
            await this._setCapSafe('solar_mode_active', false);
            this.log('Car disconnected: solar charging state set to OFF');
            this.homey.notifications.createNotification({
              excerpt: this.homey.__('notifications.solar_mode_disabled_on_disconnect'),
            }).catch(err => this.log('Notification error:', err.message));
          }
        }
      }
      this._lastMode3 = mode3;
      this._carConnected = carConnected;
      await this._setCapSafe('car_connected', carConnected);
      if (!this._paused) {
        await this._setCapSafe('evcharger_charging_state', mode3ToChargingState(mode3));
        await this._setCapSafe('evcharger_charging', isActivelyCharging(mode3));
      }
      if (this._paused) {
        await this._setCapSafe('charging_paused', true);
      } else {
        await this._setCapSafe('charging_paused', false);
      }
      if (this._solarModeEnabled) {
        await this._setCapSafe('solar_mode_active', true);
      } else {
        await this._setCapSafe('solar_mode_active', false);
      }

      await this._setCapSafe('actual_max_current', this._clean(parseFloat32(b, 12)));

      const validTimeSec = (b.readUInt16BE(16) << 16) | b.readUInt16BE(18);
      await this._setCapSafe('valid_time_remaining', validTimeSec);
      this._startValidTimeCountdown(validTimeSec);

      const maxCurrVal = this._clean(parseFloat32(b, 20));
      await this._setCapSafe('max_current', maxCurrVal);
      if (this._lbSetpointA === null && maxCurrVal >= 6) {
        const hwMax = Number(this._settings.max_current_limit) || 16;
        this._lbSetpointA = Math.min(maxCurrVal, hwMax);
      }

      await this._setCapSafe('safe_current', this._clean(parseFloat32(b, 24)));
      if (LOG) this.log(`Setpoint accounted: ${b.readUInt16BE(28) === 1 ? 'yes' : 'no'}`);
      await this._setCapSafe('charge_phases', b.readUInt16BE(30) === 3 ? '3' : '1');

    } catch (err) { this.log('pollSocketStatus err:', err.message); }
  }

  async _pollMeasurements() {
    const m = await this._readMeasurements();
    if (this._destroyed) return;

    if (m.voltage) {
      await this._setCapSafe('charger_voltage_l1', m.voltage[0]);
      await this._setCapSafe('charger_voltage_l2', m.voltage[1]);
      await this._setCapSafe('charger_voltage_l3', m.voltage[2]);
    }

    if (m.current) {
      const [cL1, cL2, cL3] = m.current;
      await this._setCapSafe('charger_current_l1', cL1);
      await this._setCapSafe('charger_current_l2', cL2);
      await this._setCapSafe('charger_current_l3', cL3);
      this._chargerCurrentA = { L1: cL1, L2: cL2, L3: cL3 };
      this._chargerReadMs   = Date.now();
    }

    if (m.power) {
      const [pL1, pL2, pL3, pSum] = m.power;
      await this._setCapSafe('charger_power_l1', pL1);
      await this._setCapSafe('charger_power_l2', pL2);
      await this._setCapSafe('charger_power_l3', pL3);
      await this._setCapSafe('measure_power', Math.round(this._selectTotalPower(pL1, pL2, pL3, pSum)));
    }

    if (m.energyKwh !== null) {
      await this._setCapSafe('meter_power', m.energyKwh);
    }
  }

  // Kiest het totaal laadvermogen volgens setting 'power_source':
  //  - phases (standaard): L1+L2+L3 (reg 338/340/342)
  //  - total:              totaalregister 344 (Real Power Sum)
  //  - auto:               fasen, maar terugvallen op 344 als de fasen 0 geven terwijl er stroom loopt
  // Sommige paal/firmware-combinaties geven 0/NaN in de faseregisters terwijl 344 wél gevuld is.
  _selectTotalPower(pL1, pL2, pL3, pSum) {
    const source  = this._settings.power_source || 'phases';
    const pPhases = pL1 + pL2 + pL3;
    const c       = this._chargerCurrentA;
    const iSum    = (c.L1 || 0) + (c.L2 || 0) + (c.L3 || 0);
    let total;
    switch (source) {
      case 'total': total = pSum; break;
      case 'auto':  total = (pPhases <= 0 && iSum > 1) ? pSum : pPhases; break;
      default:      total = pPhases;
    }
    if (LOG) this.log(`Power: fasen=${Math.round(pPhases)} W reg344=${Math.round(pSum)} W I=${iSum.toFixed(1)} A → ${Math.round(total)} W (${source})`);
    return total;
  }

  // Leest alle meetwaarden in één Modbus-request (306..377). Valt terug op losse
  // reads als de paal/firmware de blok-read weigert (Modbus exception).
  async _readMeasurements() {
    const f32 = (b, reg, base) => this._clean(parseFloat32(b, (reg - base) * 2));

    if (this._meterBlockSupported) {
      try {
        const res  = await this._clientSocket1.readHoldingRegisters(REG_METER_BLOCK_START, REG_METER_BLOCK_LEN);
        const b    = res.response._body.valuesAsBuffer;
        const base = REG_METER_BLOCK_START;
        return {
          voltage:   [f32(b, REG_VOLTAGE_L1, base), f32(b, REG_VOLTAGE_L1 + 2, base), f32(b, REG_VOLTAGE_L1 + 4, base)],
          current:   [f32(b, REG_CURRENT_L1, base), f32(b, REG_CURRENT_L1 + 2, base), f32(b, REG_CURRENT_L1 + 4, base)],
          power:     [f32(b, REG_POWER_L1, base), f32(b, REG_POWER_L1 + 2, base), f32(b, REG_POWER_L1 + 4, base), f32(b, REG_POWER_L1 + 6, base)],
          energyKwh: this._clean(parseFloat64(b, (REG_ENERGY_SUM - base) * 2) / 1000),
        };
      } catch (err) {
        if (err && err.err === 'ModbusException') {
          this._meterBlockSupported = false;
          this.log('Blok-read 306..377 niet ondersteund door deze paal — terugval op losse reads');
        } else {
          this.log('pollMeasurements (blok) err:', err.message);
          return { voltage: null, current: null, power: null, energyKwh: null };
        }
      }
    }

    const out = { voltage: null, current: null, power: null, energyKwh: null };
    try {
      const b = (await this._clientSocket1.readHoldingRegisters(REG_VOLTAGE_L1, 6)).response._body.valuesAsBuffer;
      out.voltage = [0, 4, 8].map(o => this._clean(parseFloat32(b, o)));
    } catch (err) { this.log('pollVoltage err:', err.message); }
    try {
      const b = (await this._clientSocket1.readHoldingRegisters(REG_CURRENT_L1, 6)).response._body.valuesAsBuffer;
      out.current = [0, 4, 8].map(o => this._clean(parseFloat32(b, o)));
    } catch (err) { this.log('pollCurrent err:', err.message); }
    try {
      const b = (await this._clientSocket1.readHoldingRegisters(REG_POWER_L1, 8)).response._body.valuesAsBuffer;
      out.power = [0, 4, 8, 12].map(o => this._clean(parseFloat32(b, o)));
    } catch (err) { this.log('pollPower err:', err.message); }
    try {
      const b = (await this._clientSocket1.readHoldingRegisters(REG_ENERGY_SUM, 4)).response._body.valuesAsBuffer;
      out.energyKwh = this._clean(parseFloat64(b) / 1000);
    } catch (err) { this.log('pollEnergy err:', err.message); }
    return out;
  }

  async _pauseCharging() {
    if (this._paused) return;
    // Tijdens een interne pauze staat het instelpunt op 5 A: dat is geen bruikbare waarde om naar terug te keren.
    this._prePauseSetpointA = (this._lbSetpointA !== null && this._lbSetpointA > PAUSE_CURRENT_A)
      ? this._lbSetpointA : null;
    this._paused            = true;
    this._chargingPaused    = true;
    this._clearAutoPause();   // de pauze van de gebruiker neemt het over
    await this._setCapSafe('charging_paused', true);
    this.log('Pause state changed: ON');
    if (this._socketConnected) {
      await this._writeMaxCurrentRaw(PAUSE_CURRENT_A);
      await this._setCapSafe('max_current', PAUSE_CURRENT_A);
      this._lastWriteMs = Date.now();
    }
    this._lbSetpointA = PAUSE_CURRENT_A;
    await this._setCapSafe('evcharger_charging', false);
    await this._setCapSafe('evcharger_charging_state', 'plugged_in_paused');
    this.homey.notifications.createNotification({
      excerpt: this.homey.__('notifications.pause_enabled'),
    }).catch(err => this.log('Notification error:', err.message));
    this.homey.flow.getDeviceTriggerCard('charging_paused')
      .trigger(this).catch(this.error.bind(this));
  }

  async _resumeCharging() {
    if (!this._paused) return;
    this._paused = false;
    this._chargingPaused = false;
    await this._setCapSafe('charging_paused', false);
    this.log('Pause state changed: OFF');
    if (this._prePauseSetpointA !== null) {
      this._lbSetpointA = this._prePauseSetpointA;
      if (!this._solarModeEnabled) {
        this._userMaxA = this._prePauseSetpointA;
      }
    }
    this._prePauseSetpointA = null;
    // Hervatten: minimaal de startstroom (8 A) en die 90 s vasthouden, zodat de auto
    // na een lange pauze rustig kan opstarten (voorkomt HFSwitching / fout 303).
    this._clearAutoPause();
    if (this._socketConnected) {
      if (this._solarModeEnabled) {
        const phases  = this._activeChargePhases || Number(this._settings.grid_phases) || 3;
        const { roomA } = this._fuseRoomA(phases);
        const wantA   = this._lbSetpointA !== null && this._lbSetpointA > PAUSE_CURRENT_A
          ? this._lbSetpointA : this._effectiveResumeA();
        await this._startCharging(wantA, roomA, 'hervat (zon)');
      } else {
        await this._refreshChargerCurrent();
        const lim = this._computeLbLimits();
        if (lim.fallbackA !== undefined) {
          await this._writeSetpoint(lim.fallbackA, 'hervat (fallback)');
        } else {
          await this._startCharging(lim.wantA, lim.roomA, 'hervat');
        }
      }
    }
    await this._setCapSafe('evcharger_charging', isActivelyCharging(this._lastMode3));
    await this._setCapSafe('evcharger_charging_state', mode3ToChargingState(this._lastMode3));
    this.homey.notifications.createNotification({
      excerpt: this.homey.__('notifications.pause_disabled'),
    }).catch(err => this.log('Notification error:', err.message));
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
    if (amps < 1 || amps > cableMax) throw new Error(`Current must be 1–${cableMax} A`);
    if (this._solarModeEnabled) {
      this.log('Handmatige aanpassing — solar mode uitgeschakeld');
      this._solarModeEnabled = false;
      this._solarModeActive = false;
      await this._setCapSafe('solar_mode', false);
      await this._setCapSafe('solar_mode_active', false);
      this.homey.notifications.createNotification({
        excerpt: this.homey.__('notifications.solar_mode_disabled_by_slider', { amps }),
      }).catch(err => this.log('Notification error:', err.message));
    }
    const wasPaused = this._paused || this._autoPaused;
    if (this._paused) {
      this.log(`Direct current command (${amps} A) clears pause state`);
      this._paused            = false;
      this._chargingPaused    = false;
      await this._setCapSafe('charging_paused', false);
      this._prePauseSetpointA = null;
      await this._setCapSafe('evcharger_charging', isActivelyCharging(this._lastMode3));
      this.homey.notifications.createNotification({
        excerpt: this.homey.__('notifications.pause_cleared_by_slider', { amps }),
      }).catch(err => this.log('Notification error:', err.message));
    }
    await this._writeMaxCurrentRaw(amps);
    this._lbSetpointA = amps;
    this._userMaxA    = amps;
    this._lastWriteMs = Date.now();
    this._clearAutoPause();   // expliciete keuze van de gebruiker
    if (wasPaused) this._chargeStartMs = Date.now();
    this.setStoreValue('userMaxA', amps).catch(err => this.log('setStoreValue userMaxA err:', err.message));
    await this.delay(300);
    const res = await this._clientSocket1.readHoldingRegisters(REG_MAX_CURRENT_RW, 2);
    await this._setCapSafe('max_current', this._clean(parseFloat32(res.response._body.valuesAsBuffer)));
  }

  async _writePhases(phases) {
    if (!this._socketConnected) throw new Error(this.homey.__('errors.not_connected'));
    if (phases !== 1 && phases !== 3) throw new Error('Phases must be 1 or 3');
    await this._clientSocket1.writeSingleRegister(REG_PHASES, phases);
    await this._setCapSafe('charge_phases', String(phases));
  }

  _applyCurrentLimits() {
    const hwMax  = Math.min(Math.max(Number(this._settings.max_current_limit) || 16, 1), 32);
    const phases = Number(this._settings.grid_phases) || 3;
    const maxKw  = Math.round(hwMax * phases * 230 / 100) / 10;
    const canSinglePhase = phases === 1 || !!this._settings.single_phase_solar;
    const minKw = canSinglePhase
      ? Math.round(6 * 1 * 230 / 100) / 10
      : Math.round(6 * 3 * 230 / 100) / 10;
    this.setCapabilityOptions('max_current', { min: 1, max: hwMax, step: 1 })
      .catch(err => this.log('setCapabilityOptions err:', err.message));
    if (this.hasCapability('solar_min_charge_kw')) {
      this.setCapabilityOptions('solar_min_charge_kw', { min: minKw, max: maxKw, step: 0.1 })
        .catch(err => this.log('setCapabilityOptions solar err:', err.message));
    }
  }

  async _setCapSafe(cap, value) {
    if (this._destroyed) return;
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

  async onAdded() { this.log('Device added:', this.getData().id); }

  // Eén gezamenlijke opruimroutine voor verwijderen én herstarten/updaten:
  // stopt alle timers, blokkeert verdere reconnects en sluit de socket hard.
  async _teardown() {
    if (this._destroyed) return;
    this._destroyed = true;             // eerst: blokkeert reconnects en capability-writes (geen 404-ruis)
    this._attachSeq++;
    this._destroyMeterListeners();
    if (this._reconnectTimer) { this.homey.clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this._recalcTimer)    { this.homey.clearTimeout(this._recalcTimer);    this._recalcTimer    = null; }
    if (this._pollingTimer)   { this.homey.clearInterval(this._pollingTimer);  this._pollingTimer   = null; }
    this._stopLoadBalancing();
    this._stopValidTimeCountdown();
    if (this._socket) {
      this._socket.removeAllListeners();
      this._socket.on('error', () => {});   // voorkomt unhandled 'error' na teardown
      this._socket.destroy();
    }
    this._socketConnected = false;
  }

  async onDeleted() {
    this.log('Device deleted:', this.getData().id);
    await this._teardown();
  }

  async onUninit() {
    this.log('Device uninit:', this.getData().id);
    await this._teardown();
  }
};

