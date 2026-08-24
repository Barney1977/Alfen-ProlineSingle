This app connects your Alfen Eve Single charging station (with ACE module) to Homey via Modbus TCP. The app reads the charging status, power per phase, voltage and delivered energy in real time, and gives you direct control over the charge current and number of active phases from within Homey. You can also charge using only your solar energy surplus.

The app features automatic load balancing: combined with a compatible energy meter in Homey, the app continuously adjusts the charge current based on actual household consumption, so you always stay within your main fuse limit. When consumption increases, the app automatically reduces the charge current. When consumption drops, the current is increased again.

BEFORE YOU START

Your Alfen charger must first be configured using the ACE Service Installer before the app can connect. Enable Active Load Balancing, set the Data Source to Energy Management System, configure TCP/IP EMS with Control mode Socket and a Validity time of 60 seconds, and enable Modbus TCP with read and write permissions. The charger also requires a fixed IP address on your local network, set either through the ACE Service Installer under Connectivity or via a DHCP reservation in your router. Without a fixed IP address, the app will lose its connection whenever your router assigns a new address.

ADDING THE CHARGER

Open the Homey app, go to Devices, tap the plus button and search for Alfen ACE. During pairing, enter the fixed IP address of your charger and the Modbus TCP port (default 502). The app establishes a connection and the device appears in Homey.

DEVICE SETTINGS

After adding the charger, open the device settings via the gear icon to complete the configuration.

Under Electrical installation, set how many grid phases your charger is connected to (1 or 3), the maximum current per phase of your main fuse (e.g. 25 A for a 3×25 A connection), and the maximum current of your charging cable or the charger's hardware type. Load balancing and the charge current slider will never exceed this cable limit.

Under Energy meter, paste the Homey device ID of your smart energy meter and enable automatic load balancing. You can find the device ID at developer.homey.app under Devices. The meter must report current per phase (L1, L2, L3) as a Homey capability. Compatible meters include P1 smart meters, Shelly EM/3EM, SMA Energy Meter and others. Leave this field empty if you prefer to manage load balancing manually via a Flow.

Under Load balancing, the keepalive setting must remain enabled. This periodically rewrites the calculated current setpoint to the charger so the Alfen validity timer does not expire and the charger does not fall back to a lower safe current. The interval (default 30 seconds) must be shorter than the Validity time configured in the ACE Service Installer. The safety margin (default 1 A) is subtracted per phase from the available current before the value is written to the charger, compensating for the brief delay between a measurement and the resulting adjustment. A margin of 1 to 2 A is recommended for most installations. Set whether single-phase charging is permitted (for 3-phase grid connections) — when enabled, the solar charging feature will automatically switch to single-phase if the minimum charge speed is set below 4.1 kW.

LOAD BALANCING WITHOUT AN ENERGY METER

If your energy meter does not report current per phase, you can use the Flow action "Update grid current" as an alternative. Create a Flow that triggers on your meter's current measurements and passes the values to the charger. Leave the Energy meter device ID field empty in the device settings, otherwise both methods run simultaneously and overwrite each other's setpoints.