This app connects your Alfen Eve Single EV charger (with ACE module) to Homey via Modbus TCP. It reads real-time charging status, power usage per phase, voltage, and energy delivered, and lets you control the charging current and number of active phases directly from Homey.

The app includes automatic load balancing: when combined with a compatible energy meter in Homey, it continuously adjusts the charging current to stay within your main fuse limits. When your household consumption rises, the app reduces the charging current automatically. When consumption drops, it increases it again.


BEFORE YOU START

Your Alfen charger must be configured via the ACE Service Installer before this app can connect. Enable Active Load Balancing, set the Data Source to Energy Management System, configure TCP/IP EMS with Control mode Socket and a Validity time of 60 seconds, and enable Modbus TCP with reading and writing allowed. The charger also needs a fixed IP address on your local network, either set in the ACE Service Installer under Connectivity or reserved via your router's DHCP settings. Without a fixed IP, the app will lose its connection whenever your router reassigns addresses.


ADDING THE CHARGER

Open the Homey app, go to Devices, tap the plus button, and search for Alfen ACE. During pairing you enter the fixed IP address of your charger and the Modbus TCP port (502 by default). The app will connect and the device will appear in Homey.


DEVICE SETTINGS

After adding the charger, open the device settings via the gear icon to complete the setup.

Under Electrical installation, set the number of grid phases your charger is connected to (1 or 3), the maximum current per phase of your main fuse (for example 25 A for a 3x25 A connection), and the maximum current of your charging cable or charger hardware. The load balancing and the charging current slider will never exceed this cable maximum.

Under Energy meter, paste the Homey device ID of your smart energy meter. This enables automatic load balancing. You can find the device ID on developer.homey.app under Devices. The meter must report current per phase (L1, L2, L3) as a Homey capability. Compatible meters include P1 smart meters, Shelly EM/3EM, SMA Energy Meter, and others. Leave this field empty if you prefer to control load balancing manually via a Flow.

Under Load balancing, the keepalive setting must stay enabled. It periodically resends the calculated current setpoint to the charger to prevent the Alfen validity timer from expiring and falling back to a lower safe current. The interval (default 30 seconds) must be shorter than the Validity time configured in the ACE Service Installer. The safety margin (default 1 A) is subtracted from the available current per phase before writing to the charger, to compensate for the short delay between a meter reading and the adjustment. A margin of 1 to 2 A is recommended for most installations.


LOAD BALANCING WITHOUT AN ENERGY METER

If your energy meter does not report current per phase, you can use the Flow action "Update grid current" as an alternative. Create a Flow that triggers on your meter's current readings and passes the values to the charger. Keep the Energy meter device ID field empty in the device settings, otherwise both methods will run simultaneously and overwrite each other.