Deze app verbindt je Alfen Eve Single laadpaal (met ACE-module) via Modbus TCP met Homey. De app leest real-time de laadstatus, het vermogen per fase, de spanning en de geleverde energie, en geeft je directe controle over de laadstroom en het aantal actieve fasen vanuit Homey.

De app beschikt over automatische laadbalancering: in combinatie met een compatibele energiemeter in Homey past de app de laadstroom continu aan op basis van het actuele verbruik in huis, zodat je altijd onder de hoofdzekering blijft. Neemt het verbruik toe, dan verlaagt de app de laadstroom automatisch. Daalt het verbruik, dan wordt de stroom weer verhoogd.


VOORDAT JE BEGINT

Je Alfen-lader moet eerst worden geconfigureerd via de ACE Service Installer voordat de app verbinding kan maken. Schakel Active Load Balancing in, stel de Data Source in op Energy Management System, configureer TCP/IP EMS met Control mode Socket en een Validity time van 60 seconden, en schakel Modbus TCP in met lees- en schrijfrechten. De lader heeft ook een vast IP-adres nodig in je lokale netwerk, in te stellen via de ACE Service Installer onder Connectivity of via een DHCP-reservering in je router. Zonder vast IP-adres verliest de app de verbinding zodra je router een nieuw adres uitdeelt.


LADER TOEVOEGEN

Open de Homey-app, ga naar Apparaten, tik op de plusknop en zoek naar Alfen ACE. Tijdens het koppelen voer je het vaste IP-adres van je lader in en de Modbus TCP-poort (standaard 502). De app maakt verbinding en het apparaat verschijnt in Homey.


APPARAATINSTELLINGEN

Nadat je de lader hebt toegevoegd, open je de apparaatinstellingen via het tandwiel-icoon om de configuratie te voltooien.

Stel onder Elektrische installatie in op hoeveel netstroom fasen je lader is aangesloten (1 of 3), wat de maximale stroom per fase is van je hoofdzekering (bijv. 25 A bij een 3x25 A aansluiting), en wat de maximale stroom is van je laadkabel of het hardwaretype van de lader. De laadbalancering en de laadstroom-schuifregelaar gaan nooit boven deze kabelgrens.

Plak onder Energiemeter het Homey-apparaat-ID van je slimme energiemeter. Dit activeert de automatische laadbalancering. Het apparaat-ID vind je op developer.homey.app onder Apparaten. De meter moet stroom per fase (L1, L2, L3) als Homey-capability rapporteren. Compatibele meters zijn onder andere P1-slimme meters, Shelly EM/3EM, SMA Energy Meter en andere. Laat dit veld leeg als je de laadbalancering liever handmatig via een Flow beheert.

Onder Laadbalancering moet de keepalive-instelling ingeschakeld blijven. Deze stuurt het berekende stroomsetpoint periodiek opnieuw naar de lader, zodat de Alfen validity timer niet afloopt en de lader niet terugvalt op een lagere veilige stroom. Het interval (standaard 30 seconden) moet korter zijn dan de Validity time die is ingesteld in de ACE Service Installer. De veiligheidsmarge (standaard 1 A) wordt per fase afgetrokken van de beschikbare stroom voordat de waarde naar de lader wordt geschreven, als compensatie voor de korte vertraging tussen een meting en de aanpassing. Een marge van 1 tot 2 A wordt voor de meeste installaties aanbevolen.


LAADBALANCERING ZONDER ENERGIEMETER

Als je energiemeter geen stroom per fase rapporteert, kun je de Flow-actie "Netstroom bijwerken" als alternatief gebruiken. Maak een Flow die triggert op de stroommetingen van je meter en geef de waarden door aan de lader. Laat het veld Energiemeter apparaat-ID leeg in de apparaatinstellingen, anders draaien beide methoden tegelijk en overschrijven ze elkaars setpoints.