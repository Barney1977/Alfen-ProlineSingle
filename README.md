# Alfen ACE — Homey Modbus integratie

Verbindt een Alfen Eve Single laadpaal (met ACE module) via Modbus TCP met Homey. Ondersteunt real-time statusmonitoring, dynamische laadbalancering op basis van een aangesloten energiemeter, en directe sturing van laadstroom en fase-instelling.

---

## Vereisten op de lader

Voordat de app kan verbinden moeten de volgende instellingen worden geconfigureerd via de **ACE Service Installer** (vereist een service-account bij Alfen):

1. Ga naar **Load Balancing → Active Load Balancing** en activeer het vinkje.
2. Stel **Data Source** in op **Energy Management System**.
3. Ga naar **TCP/IP EMS** en stel in:
   - **Control mode**: Socket
   - **Validity time**: 60 seconden (standaard — zie ook instelling *Laadbalancering interval*)
4. Ga naar **Modbus TCP/IP** en zet aan:
   - **Allow reading**
   - **Allow writing maximum currents**
   - **Enable sockets**
5. Wijs een **vast IP-adres** toe aan de lader — zie sectie *Netwerkconfiguratie* hieronder.

---

## Installatie

```bash
npm install
homey app run      # testen (live logging)
homey app install  # installeren op Homey
```

---

## Koppelen (pairing)

Voer tijdens het koppelen in:

| Veld | Waarde |
|---|---|
| IP-adres | Vaste IP van de lader |
| Modbus TCP poort | `502` (standaard) |

De app gebruikt automatisch unit-adres **1** voor socket-registers en **200** voor station-registers. Dit hoeft niet ingesteld te worden.

---

## Netwerkconfiguratie

### Waarom een vast IP-adres essentieel is

De Alfen lader verbindt via een persistent TCP-socket. Het IP-adres wordt één keer opgeslagen in de Homey device-instellingen. Als de lader na een herstart van de router of een DHCP-lease-verlenging een **ander IP-adres** krijgt, verliest de app de verbinding permanent totdat het IP handmatig wordt gecorrigeerd.

Concrete gevolgen bij een IP-adreswijziging:

- De Modbus-verbinding valt weg — de app kan de lader niet meer lezen of aansturen.
- De Alfen validity timer loopt af (na 60 s) — de lader valt terug op de geconfigureerde safe current.
- Laadbalancering stopt volledig totdat de verbinding is hersteld.
- Het device toont *"Verbinding verbroken"* in Homey.

### Vast IP instellen: twee methoden

**Methode 1 — Vast IP in de ACE Service Installer (aanbevolen)**

Dit is de meest stabiele methode: het IP-adres is opgeslagen in de lader zelf en blijft behouden na elke herstart of firmware-update.

1. Open de ACE Service Installer en selecteer de lader.
2. Klik op **Connectivity** in het lint bovenaan.
3. Klik in de linkerzijbalk op **Wired**.
4. Vink **Fixed IP address** aan.
5. Vul in: IP-adres, subnetmasker, gateway en DNS.
6. Sla op en herstart de lader.

> Kies een adres buiten de DHCP-pool van uw router (bijv. router deelt 192.168.1.100–200 uit via DHCP → gebruik 192.168.1.10–99 voor vaste apparaten).

**Methode 2 — DHCP-reservering in de router**

De lader blijft DHCP gebruiken maar de router geeft altijd hetzelfde adres op basis van het MAC-adres. Dit werkt zonder ACE Service Installer-toegang.

1. Zoek het MAC-adres van de lader (staat op het typeplaatje of in de ACE Service Installer onder Connectivity → Wired).
2. Voeg in de router een DHCP-reservering toe: MAC-adres → gewenst IP-adres.
3. Herstart de lader zodat hij het gereserveerde adres ophaalt.

> Nadeel: bij vervanging van de router of reset van DHCP-instellingen kan de reservering verloren gaan.

### Hetzelfde geldt voor Homey zelf

Als Homey draait op een IP-adres dat kan wijzigen, kunnen de WebSocket-verbindingen met de Plugwise Smile P1 (voor laadbalancering) instabiel worden. Wijs ook aan Homey een vast IP toe via dezelfde methoden.

### IP-adres wijzigen na koppeling

Als het IP-adres van de lader toch verandert, pas het dan aan via:
**Homey-app → Device → Instellingen (tandwiel) → IP-adres**

De app herstelt automatisch de verbinding na het opslaan.

---

## Device instellingen

Na het koppelen zijn de volgende instellingen beschikbaar via het tandwiel-icoon op het device.

### Verbinding

| Instelling | Standaard | Omschrijving |
|---|---|---|
| IP-adres | — | IP-adres van de lader |
| Modbus TCP poort | `502` | Poort voor Modbus TCP verbinding |

### Elektrische installatie

| Instelling | Standaard | Omschrijving |
|---|---|---|
| Aantal netstroom fasen | `3` | Aantal fasen waarop de lader is aangesloten: 1 of 3 |
| Hoofdzekering per fase (A) | `25 A` | Maximale belasting per fase vanuit de meterkast, bijv. 25 A bij een 3×25 A aansluiting. De laadbalancering houdt iedere fase hier onder. |
| Laadkabel maximale stroom (A) | `16 A` | Maximale stroom van de laadkabel of het hardware type van de lader. Dit is de absolute bovengrens voor alle stroomsturing — de schuifregelaar en laadbalancering gaan nooit boven deze waarde. |

### Energiemeter (automatische laadbalancering)

| Instelling | Standaard | Omschrijving |
|---|---|---|
| Energiemeter device ID | *(leeg)* | Homey device-ID van de energiemeter die per fase de netstroom meet. Zie sectie *Automatische laadbalancering* hieronder. |

### Laadbalancering

| Instelling | Standaard | Omschrijving |
|---|---|---|
| Laadbalancering keepalive | `aan` | Schrijft het berekende stroomsetpoint periodiek opnieuw naar de lader. **Moet aan staan** om terugval naar de Alfen safe current te voorkomen (Alfen validity time = standaard 60 s). |
| Laadbalancering interval (s) | `30 s` | Hoe vaak het setpoint herschreven wordt. Moet **altijd kleiner zijn dan de Alfen validity time** (standaard 60 s). Bij gelijkheid of overschrijding toont het device een waarschuwing en kan de lader terugvallen op de safe current. Aanbevolen: 30 s. |
| Veiligheidsmarge per fase (A) | `1 A` | Wordt per fase van de beschikbare stroom afgetrokken voordat de waarde naar de lader wordt geschreven. Compenseert voor meetvertraging tussen energiemeter en sturing. Aanbevolen: 1–2 A. |

---

## Automatische laadbalancering

De app kan de laadstroom automatisch aanpassen op basis van het actuele verbruik in de rest van de installatie. Hiervoor is een energiemeter op Homey nodig die per fase de netstroom (in A) meet.

### Instellen

1. Ga op `developer.homey.app` naar **Devices** en zoek uw energiemeter op.
2. Kopieer het **device ID** (formaat: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`).
3. Plak dit ID in de instelling **Energiemeter device ID** van de laadpaal.
4. De app controleert automatisch of het device de capabilities `measure_current.L1`, `.L2` en `.L3` aanbiedt (bij 3-fase) of alleen `.L1` (bij 1-fase).

Zodra een auto wordt aangesloten (Mode 3 status B of C) begint de app real-time de laadstroom te berekenen en schrijft die naar de lader. De berekening per fase is:

```
beschikbaar_Ln = hoofdzekering_A − gemeten_netstroom_Ln_A + huidig_laadsetpoint_A − veiligheidsmarge_A
setpoint_A     = clamp(min(beschikbaar_L1, L2, L3), 6 A, kabelmax_A)
```

Het huidig laadsetpoint wordt opgeteld omdat de energiemeter het totale verbruik meet inclusief de lader. Zonder deze correctie zou de berekening elke stap het setpoint verlagen totdat het op de minimumwaarde staat.

### Timing en veiligheidsmarge

De laadbalancering werkt **event-driven**: elke keer dat de Plugwise Smile P1 een nieuwe meting doorstuurt, berekent de app direct de optimale laadstroom en schrijft die naar de lader. Er is geen polling-vertraging tussen meting en actie.

**Meetinterval van de slimme meter**

De P1-poort van de slimme meter (DSMR) levert metingen met een vast interval:

| DSMR versie | Interval | Opmerking |
|---|---|---|
| DSMR 5.0 (na 2016) | elke 1 seconde | Meeste moderne Nederlandse meters |
| DSMR 4.x (2013–2016) | elke 10 seconden | Oudere meters |

De Plugwise Smile P1 geeft deze waarden door aan Homey. Het exacte interval waarmee de Homey-app updates verstuurt is afhankelijk van de gebruikte app-versie.

**Het inherente tijdvenster**

Tussen twee opeenvolgende metingen kan het verbruik in huis veranderen — een waterkoker, inductiekookplaat of wasmachine die start, trekt direct 8–16 A extra. De laadbalancering ziet dit pas bij de volgende P1-update. In het slechtste geval laadt de auto 1–10 seconden te zwaar door voordat de correctie plaatsvindt.

Dit is geen bug maar een fundamentele eigenschap van alle reactieve laadbalancessystemen die op een externe energiemeter steunen.

**Rol van de veiligheidsmarge**

De instelling *Veiligheidsmarge per fase* is de enige buffer tegen dit tijdvenster. Een hogere marge verkleint het risico op kortstondige overbelasting, maar beperkt ook het maximale laadvermogen:

| Situatie | Aanbevolen marge |
|---|---|
| DSMR 5.0, stabiel huishoudelijk verbruik | 1–2 A |
| DSMR 4.x (10s interval) of wisselend verbruik | 3–4 A |
| Inductiekookplaat of andere grote plotselinge lasten op hetzelfde circuit | 4–6 A |

Een marge van 2 A bij een 3×25 A aansluiting betekent dat de lader maximaal 3×2 A = 6 A minder kan laden dan de theoretische maximum — bij een 16 A kabel dus maximaal 14 A in plaats van 16 A.

**Keepalive timer vs. meetinterval**

De LB-keepalivetimer (standaard 30 s) heeft een andere functie dan de laadbalancering zelf: hij schrijft de *laatste berekende waarde* opnieuw naar de Alfen om te voorkomen dat de validity timer (60 s) afloopt. De eigenlijke laadstromaanpassing gebeurt event-driven bij elke P1-update, niet op de keepalive-cyclus. Er is geen synchronisatierisico tussen beide: de keepalive herberekent altijd met de meest recente meterdata.

### Compatibele energiemeters

Elke Homey-app die `measure_current.L1` (en `.L2`, `.L3` bij 3-fase) als capability aanbiedt werkt. Voorbeelden:

- **P1 slimme meter** (bijv. via de Homey P1-app of DSMR-app)
- **Shelly EM / 3EM**
- **SMA Energy Meter**
- **Eastron SDM** meters
- **Homey Energy dongle**

---

## Fallback: laadbalancering via flow

Als de energiemeter geen `measure_current` per fase aanbiedt, of als u de sturing liever handmatig via flows beheert, kunt u de flow action **"Netstroom bijwerken"** gebruiken als alternatief voor de automatische listener.

### Verplichte stappen bij gebruik van de flow-fallback

> ⚠️ **Laat het veld "Energiemeter device ID" leeg** als u de fallback flow gebruikt. Anders probeert de app beide methoden tegelijk en kunnen setpoints elkaar overschrijven.

De flow die u moet aanmaken:

**Als** `[Energiemeter] — stroom L1 verandert`  
**Dan** `[Alfen ACE] — Netstroom bijwerken: L1 = [L1-stroom token] A, L2 = [L2-stroom token] A, L3 = [L3-stroom token] A`

Aanvullende aandachtspunten bij de flow-fallback:

- Maak **één flow per fase-trigger** of gebruik een flow die op alle drie fasen tegelijk triggert (bijv. via een variabele of een gecombineerde trigger als uw energiemeter dat ondersteunt).
- Zorg dat de flow **vaker triggert dan de Alfen validity time** (standaard 60 s). Als de flow te weinig afgaat — bijv. alleen bij een grote verbruikswijziging — kan de lader terugvallen op de safe current. Voeg zo nodig een aparte **tijdgebaseerde flow** toe die elke 30 s de laatste bekende waarden opnieuw doorgeeft.
- De flow action accepteert **0** voor fasen die niet gebruikt worden (bij 1-fase installatie: L2 = 0, L3 = 0).

---

## Flow cards

### Als (triggers)

| Trigger | Wanneer |
|---|---|
| Laden gestart | Auto gaat van inactief naar actief laden (Mode 3: C2 of D2) |
| Laden gestopt | Auto stopt met laden |
| Auto aangesloten | Stekker wordt ingeplugd (Mode 3: B of C) |
| Auto losgekoppeld | Stekker wordt uitgetrokken (Mode 3: A) |
| Laadstatus veranderd *(automatisch)* | Bij elke Mode 3 statuswijziging — via `evcharger_charging_state` capability |
| Laadvermogen veranderd *(automatisch)* | Bij elke vermogenswijziging — via `measure_power` capability |

### En (conditions)

| Conditie | Test |
|---|---|
| Lader is (niet) aan het laden | Controleert of Mode 3 actief laden is (C2/D2) |
| Auto is (niet) aangesloten | Controleert of een voertuig verbonden is (B/C/D) |
| Laadstatus is (niet) *(automatisch)* | Vergelijkt `evcharger_charging_state` met een gekozen status |

### Dan (actions)

| Actie | Omschrijving |
|---|---|
| Netstroom bijwerken | Geeft per fase gemeten netstroom door voor laadbalanceringsberekening *(fallback voor flow-gestuurde LB)* |
| Maximale laadstroom instellen | Schrijft een vaste stroomwaarde direct naar de lader, omzeilt laadbalancering |
| Laadphases instellen | Schakelt tussen 1-fase en 3-fase laden |

---

## Capabilities

### Leesbaar

| Capability | Omschrijving | Modbus register |
|---|---|---|
| `evcharger_charging_state` | Laadstatus: plugged_out / plugged_in / plugged_in_charging / plugged_in_paused | 1201 (Mode 3, STRING) |
| `measure_power` | Totaal laadvermogen (W) | 344 (FLOAT32) |
| `measure_power.L1/L2/L3` | Vermogen per fase (W) | 338/340/342 |
| `measure_voltage.L1/L2/L3` | Spanning per fase (V) | 306/308/310 |
| `measure_current.L1/L2/L3` | Stroom per fase van de lader (A) | 320/322/324 |
| `meter_power` | Totaal geleverde energie (kWh) | 374 (FLOAT64) |
| `actual_max_current` | Werkelijk door lader toegepaste max stroom (A) | 1206 (FLOAT32) |
| `safe_current` | Fallback safe current (A) — geconfigureerd in ACE Service Installer | 1212 (FLOAT32) |
| `station_max_current` | Station-brede actieve max stroom (A) — unit 200 | 1100 (FLOAT32) |
| `valid_time_remaining` | Resterende tijd voor de huidige setpoint vervalt (s) | 1208 (UNSIGNED32) |

### Instelbaar

| Capability | Omschrijving | Bereik |
|---|---|---|
| `max_current` | Laadstroom setpoint (A) — slider in Homey UI | 6 A tot *kabelmax* |
| `charge_phases` | Aantal laadphases | 1 of 3 |

---

## Performance

### Geheugengebruik

De app verbruikt circa **50 KB** per gekoppeld device. Dit bestaat uit de TCP-socketbuffer (~8 KB), twee jsmodbus-clientobjecten (~4 KB), drie WebSocket-listeners voor de energiemeter (~6 KB) en de Homey capability-waarden (~10 KB). Er zijn geen groeiende datastructuren — elke poll overschrijft de vorige waarden.

Ter vergelijking: een Homey Pro 2023 heeft ~200 MB beschikbaar voor apps. De laadpaal-app verbruikt 0,025% daarvan.

### CPU en netwerk

De app heeft twee periodieke timers en één event-driven pad:

| Pad | Interval | Werk |
|---|---|---|
| Modbus poll | 30 s | 6 TCP-requests naar de lader |
| LB keepalive | 30 s | 1 TCP-write naar de lader |
| P1 meter callback | ~1 s (DSMR 5.0) | 1 berekening (~0,01 ms), schrijft alleen bij gewijzigd setpoint |

**Per uur totaal**: 720 Modbus-reads, 120 keepalive-writes, ~3.600 LB-berekeningen, ~30 Modbus-writes (bij normaal wisselend verbruik).

**TCP-verkeer per uur**: ~54 KB naar/van de lader — verwaarloosbaar op een lokaal netwerk.

### Modbus poll-optimalisatie

De 7 statusregisters van de lader (availability, Mode 3-status, actuele stroom, geldigheidstijd, max stroom, veilige stroom, laadphases) staan aaneengesloten op adressen 1199–1214. De app leest deze in **één bulkverzoek** in plaats van 7 afzonderlijke verzoeken. Dit halveert het aantal Modbus round-trips per poll-cyclus van 12 naar 6, en verkort de polltijd van ~60 ms naar ~30 ms.

### Vergelijking

| App | Poll | Modbus-requests/uur |
|---|---|---|
| Alfen ACE (deze app) | 30 s | **720** |
| Stiebel Eltron ISG (basis) | 10 s | 4.320 |
| Typische Zigbee-lamp | event | 0 |

## Modbus technische details

- **Twee unit-adressen** op één TCP-verbinding: `1` (socket-registers) en `200` (station-registers)
- **Register offset**: datasheet-adres − 1 = Modbus-adres (bijv. datasheet 1210 → Modbus adres 1209)
- **FLOAT32 mixed-endian**: low word eerst in de registerstream, big-endian binnen elk 16-bit word
- **FLOAT64**: vier registers, zelfde mixed-endian volgorde
- **FC03** voor lezen (holding registers), **FC16** voor schrijven van FLOAT32 (beide words in één request), **FC06** voor schrijven van UNSIGNED16
- **Validity time**: het setpoint in register 1210 vervalt na de geconfigureerde validity time (standaard 60 s). De keepalive timer herschrijft de waarde elke *lb_interval* seconden.

---

## Bestandsstructuur

```
alfen-ace/
├── app.js                              ← HomeyAPI instantie (cross-device toegang)
├── app.json                            ← app manifest, permissions
├── package.json
├── locales/
│   ├── en.json
│   └── nl.json
├── assets/
│   ├── icon.svg
│   └── images/
└── drivers/
    └── alfen-ace/
        ├── device.js                   ← Modbus, laadbalancering, meter listener
        ├── driver.js                   ← pairing
        ├── driver.compose.json         ← capabilities
        ├── driver.flow.compose.json    ← flow cards
        ├── driver.setting.compose.json ← device instellingen
        ├── assets/
        └── pair/
            └── device.html
```
