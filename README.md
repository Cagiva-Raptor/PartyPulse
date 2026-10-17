# PartyPulse

Live Google Photos album slideshow voor feesten. Gasten uploaden foto's via een
gedeelde album-link; PartyPulse speelt het album fullscreen af en toont **nieuwe
uploads meteen** als volgende foto — geen reload, geen wachten tot de lijst rond is.

## Hoe het werkt

- Leest een **publiek gedeeld** Google Photos-album uit zonder OAuth: de album-pagina
  bevat de volledige fotolijst in een ingebedde RPC-payload (`AF_initDataCallback`, key
  `ds:1`). Alleen de Python-standaardbibliotheek, geen dependencies.
- De browser toont foto na foto (crossfade). Bij een nieuwe upload onderbreekt de
  slideshow de huidige foto en toont de nieuwe direct, met een **NIEUW**-badge.
- Aan het einde van elke ronde wordt de lijst automatisch ververst.

## Draaien

```bash
python3 slideshow.py
```

Open dan `http://<host>:11111/`. Klik of druk een toets voor volledig scherm;
`i` togglet de album-naam/statusregel.

## Instellingen

Via de web-UI op `/config`, of rechtstreeks in `config.json`:

| sleutel | betekenis | default |
|---|---|---|
| `album_url` | share-link van het album (`https://photos.app.goo.gl/…`) | — |
| `port` | poort | `11111` |
| `slide_seconds` | seconden per foto | `6` |
| `order` | `oldest` / `newest` / `none` | `oldest` |
| `image_width` | opgevraagde beeldbreedte (px) | `1600` |
| `thumb_width` | breedte van het voorlaad-thumbnail | `480` |
| `cache_seconds` | server-cache op de albumlijst | `5` |
| `poll_seconds` | hoe vaak op nieuwe foto's gecontroleerd wordt | `5` |
| `priority_new` | nieuwe foto's direct als volgende tonen (huidige onderbreken) | `true` |
| `min_show_seconds` | minimumtijd per foto vóór een onderbreking | `1.5` |
| `show_overlay` | album-naam, status en ronde-duur tonen | `true` |

De statusregel toont ook de duur van een volledige ronde (`slide_seconds × aantal foto's`).

## systemd

```ini
[Unit]
Description=PartyPulse — Google Photos album slideshow
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/opencode/PartyPulse
ExecStart=/usr/bin/python3 /opt/opencode/PartyPulse/slideshow.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## Kanttekeningen

- Het album moet **publiek gedeeld** blijven; de lijst wordt via de publieke pagina
  uitgelezen (geen OAuth).
- Video's verschijnen enkel als stilstaand beeld.
- De server heeft **geen authenticatie**. Zet hem niet zomaar open; zie hieronder.

## Beveiligen (aanbevolen)

PartyPulse is bedoeld voor een vertrouwd (feest-)LAN. Wil je de web-UI en `/config`
afschermen, zet er HTTP **Basic Auth** voor (credentials in een `chmod 600`-bestand,
niet in `config.json` of de systemd-unit) en combineer dat met HTTPS.
